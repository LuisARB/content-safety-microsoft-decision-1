targetScope = 'resourceGroup'

param apimName string
param foundryName string
param appInsightsName string
param tenantId string
param apiAudience string
param webLocation string
param staticSiteName string
param modelDeploymentName string
@minValue(1)
@maxValue(2160)
param modelCapacity int
@allowed(['DataZoneStandard'])
param modelDeploymentType string = 'DataZoneStandard'

resource gateway 'Microsoft.ApiManagement/service@2024-05-01' existing = { name: apimName }
resource foundry 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = { name: foundryName }
resource insights 'Microsoft.Insights/components@2020-02-02' existing = { name: appInsightsName }
var monitoringPublisherRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '3913510d-42f4-4e42-8a64-420c390055eb')
resource monitoringAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(insights.id, gateway.id, monitoringPublisherRole)
  scope: insights
  properties: {
    principalId: gateway.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: monitoringPublisherRole
  }
}

resource web 'Microsoft.Web/staticSites@2023-12-01' = {
  name: staticSiteName
  location: webLocation
  sku: { name: 'Free', tier: 'Free' }
  properties: { stagingEnvironmentPolicy: 'Disabled' }
}
resource model 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = {
  parent: foundry
  name: modelDeploymentName
  sku: { name: modelDeploymentType, capacity: modelCapacity }
  properties: {
    model: { format: 'Microsoft', name: 'Microsoft-Decision-1', version: '1' }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}

var settingNames = [
  'insurance-tenant-id'
  'insurance-api-audience'
  'insurance-allowed-origin'
  'insurance-decision-endpoint'
  'insurance-decision-deployment'
  'insurance-contentsafety-endpoint'
]
var values = [
  tenantId
  apiAudience
  'https://${web.properties.defaultHostname}'
  'https://${foundryName}.services.ai.azure.com'
  modelDeploymentName
  'https://${foundryName}.cognitiveservices.azure.com'
]
resource settings 'Microsoft.ApiManagement/service/namedValues@2024-05-01' = [for (name, i) in settingNames: {
  parent: gateway
  name: name
  properties: { displayName: name, value: values[i], secret: false }
}]
resource api 'Microsoft.ApiManagement/service/apis@2024-05-01' = {
  parent: gateway
  name: 'insurance-moderation'
  properties: {
    displayName: 'Insurance Decision-1 pilot'
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
resource policy 'Microsoft.ApiManagement/service/apis/policies@2024-05-01' = {
  parent: api
  name: 'policy'
  properties: { format: 'rawxml', value: loadTextContent('../policies/moderation.xml') }
  dependsOn: [settings, operation, model]
}
resource logger 'Microsoft.ApiManagement/service/loggers@2024-05-01' = {
  parent: gateway
  name: 'insurance-pilot-insights'
  properties: {
    loggerType: 'applicationInsights'
    resourceId: insights.id
    credentials: {
      connectionString: insights.properties.ConnectionString
      identityClientId: 'SystemAssigned'
    }
    isBuffered: true
  }
  dependsOn: [monitoringAccess]
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

// Verify the existing APIM-to-Foundry Cognitive Services User assignment before deployment.
// Shared parent resources, their network settings, and the original API are not redeclared.
output spaOrigin string = 'https://${web.properties.defaultHostname}'
output staticSiteName string = web.name
output gatewayUrl string = gateway.properties.gatewayUrl
output decisionEndpoint string = 'https://${foundryName}.services.ai.azure.com/providers/microsoft/v1/systemone'
output contentSafetyEndpoint string = 'https://${foundryName}.cognitiveservices.azure.com/contentsafety/text:analyze?api-version=2024-09-01'
output modelDeployment string = model.name
