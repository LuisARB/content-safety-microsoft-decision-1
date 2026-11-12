targetScope = 'resourceGroup'

@description('Azure region supporting the selected Decision-1 deployment type. No automatic regional fallback.')
param location string
@description('Globally unique lowercase alphanumeric prefix, 3-14 characters.')
@minLength(3)
@maxLength(14)
param prefix string
param tenantId string
@description('Application/client GUID of the Entra API registration, whose tokens use version 2.')
param apiAudience string
param publisherEmail string
param publisherName string
@allowed(['Developer'])
@description('Nonproduction pilot tier. Developer has no production SLA.')
param apimSku string = 'Developer'
@allowed(['DataZoneStandard', 'GlobalStandard'])
param decisionDeploymentType string = 'DataZoneStandard'
@minValue(1)
param decisionCapacity int = 1
param decisionDeploymentName string = 'insurance-decision-1'
@description('Additional SPA origin for local testing, blank disables local browser access.')
param allowedOriginOverride string = ''
@description('Static Web Apps supported region; independent of the model inference region.')
param webLocation string = 'westeurope'

var cognitiveUserRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'a97b65f3-24c7-4388-baec-2e87135dc908')
var names = {
  apim: '${prefix}-apim'
  foundry: '${prefix}-foundry'
  safety: '${prefix}-safety'
}

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-logs'
  location: location
  properties: {
    retentionInDays: 30
    sku: { name: 'PerGB2018' }
  }
}
resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${prefix}-insights'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
    DisableLocalAuth: false
    IngestionMode: 'LogAnalytics'
  }
}
resource web 'Microsoft.Web/staticSites@2023-12-01' = {
  name: '${prefix}-web'
  location: webLocation
  sku: { name: 'Free', tier: 'Free' }
  properties: { stagingEnvironmentPolicy: 'Disabled' }
}
resource foundry 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: names.foundry
  location: location
  kind: 'AIServices'
  sku: { name: 'S0' }
  identity: { type: 'SystemAssigned' }
  properties: {
    allowProjectManagement: true
    customSubDomainName: names.foundry
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}
resource project 'Microsoft.CognitiveServices/accounts/projects@2025-06-01' = {
  parent: foundry
  name: 'insurance-pilot'
  location: location
  identity: { type: 'SystemAssigned' }
  properties: { displayName: 'Insurance Decision Pilot', description: 'Synthetic content moderation evaluation only' }
}
resource model 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = {
  parent: foundry
  name: decisionDeploymentName
  sku: { name: decisionDeploymentType, capacity: decisionCapacity }
  properties: {
    model: { format: 'Microsoft', name: 'Microsoft-Decision-1', version: '1' }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}
resource safety 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: names.safety
  location: location
  kind: 'ContentSafety'
  sku: { name: 'S0' }
  properties: {
    customSubDomainName: names.safety
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}
resource gateway 'Microsoft.ApiManagement/service@2024-05-01' = {
  name: names.apim
  location: location
  sku: { name: apimSku, capacity: 1 }
  identity: { type: 'SystemAssigned' }
  properties: { publisherEmail: publisherEmail, publisherName: publisherName }
}
resource foundryAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(foundry.id, gateway.id, cognitiveUserRole)
  scope: foundry
  properties: {
    principalId: gateway.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: cognitiveUserRole
  }
}
resource safetyAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(safety.id, gateway.id, cognitiveUserRole)
  scope: safety
  properties: {
    principalId: gateway.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: cognitiveUserRole
  }
}
var settings = [
  { name: 'insurance-tenant-id', value: tenantId }
  { name: 'insurance-api-audience', value: apiAudience }
  { name: 'insurance-allowed-origin', value: empty(allowedOriginOverride) ? 'https://${web.properties.defaultHostname}' : allowedOriginOverride }
  { name: 'insurance-decision-endpoint', value: 'https://${names.foundry}.services.ai.azure.com' }
  { name: 'insurance-decision-deployment', value: decisionDeploymentName }
  { name: 'insurance-contentsafety-endpoint', value: 'https://${names.safety}.cognitiveservices.azure.com' }
]
var settingNames = ['insurance-tenant-id', 'insurance-api-audience', 'insurance-allowed-origin', 'insurance-decision-endpoint', 'insurance-decision-deployment', 'insurance-contentsafety-endpoint']
resource namedValues 'Microsoft.ApiManagement/service/namedValues@2024-05-01' = [for (name, i) in settingNames: {
  parent: gateway
  name: name
  properties: { displayName: name, value: settings[i].value, secret: false }
}]
resource api 'Microsoft.ApiManagement/service/apis@2024-05-01' = {
  parent: gateway
  name: 'moderation'
  properties: {
    displayName: 'Insurance Decision gate'
    path: 'moderation'
    protocols: ['https']
    subscriptionRequired: false
    apiRevision: '1'
  }
}
resource operation 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = {
  parent: api
  name: 'analyze'
  properties: { displayName: 'Analyze prompt', method: 'POST', urlTemplate: '/analyze' }
}
resource apiPolicy 'Microsoft.ApiManagement/service/apis/policies@2024-05-01' = {
  parent: api
  name: 'policy'
  properties: {
    format: 'rawxml'
    value: loadTextContent('../policies/moderation.xml')
  }
  dependsOn: [namedValues, operation, foundryAccess, safetyAccess, model]
}
resource logger 'Microsoft.ApiManagement/service/loggers@2024-05-01' = {
  parent: gateway
  name: 'metadata-insights'
  properties: {
    loggerType: 'applicationInsights'
    resourceId: insights.id
    credentials: { instrumentationKey: insights.properties.InstrumentationKey }
    isBuffered: true
  }
}
resource diagnostic 'Microsoft.ApiManagement/service/apis/diagnostics@2024-05-01' = {
  parent: api
  name: 'applicationinsights'
  properties: {
    loggerId: logger.id
    alwaysLog: 'allErrors'
    logClientIp: false
    httpCorrelationProtocol: 'W3C'
    verbosity: 'information'
    sampling: { samplingType: 'fixed', percentage: 100 }
    frontend: {
      request: { body: { bytes: 0 }, headers: [] }
      response: { body: { bytes: 0 }, headers: ['X-Request-Id'] }
    }
    backend: {
      request: { body: { bytes: 0 }, headers: [] }
      response: { body: { bytes: 0 }, headers: [] }
    }
  }
}

output gatewayUrl string = gateway.properties.gatewayUrl
output spaOrigin string = 'https://${web.properties.defaultHostname}'
output staticSiteName string = web.name
output foundryEndpoint string = 'https://${names.foundry}.services.ai.azure.com'
output contentSafetyEndpoint string = 'https://${names.safety}.cognitiveservices.azure.com'
output apimPrincipalId string = gateway.identity.principalId
output projectId string = project.id
output allowedOrigin string = empty(allowedOriginOverride) ? 'https://${web.properties.defaultHostname}' : allowedOriginOverride
