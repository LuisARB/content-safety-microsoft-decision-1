using System.Xml.Linq;
using Newtonsoft.Json.Linq;

public class Jwt { public string Subject => "fixture-user"; }
public interface IResponse { int StatusCode { get; } Body Body { get; } }
public class Response(int statusCode, string body) : IResponse
{
    public int StatusCode { get; } = statusCode;
    public Body Body { get; } = new(body);
}
public class Body(string text)
{
    public T As<T>(bool preserveContent = false) => typeof(T) == typeof(string)
        ? (T)(object)text : (T)(object)JObject.Parse(text);
}
public class Request
{
    public Dictionary<string, string> Headers { get; } = new() { ["Content-Type"] = "application/json" };
    public Body Body { get; set; }
}
public class LastError { public string Reason { get; set; } = ""; }
public class Context
{
    public Guid RequestId { get; } = Guid.NewGuid();
    public DateTime Timestamp { get; } = DateTime.UtcNow;
    public Dictionary<string, object> Variables { get; } = new();
    public Request Request { get; } = new();
    public LastError LastError { get; } = new();
}
public static class Extensions
{
    public static T GetValueOrDefault<T>(this Dictionary<string, object> dictionary, string key, T fallback = default)
        => dictionary.TryGetValue(key, out var value) ? (T)value : fallback;
}
public sealed class Returned(int status, JObject body) : Exception
{
    public int Status { get; } = status;
    public JObject Payload { get; } = body;
}
public class Interpreter(XDocument document, Context context, Queue<IResponse> responses)
{
    public List<string> Calls { get; } = new();
    object Value(string text) => text.StartsWith("@") ? Expressions.Evaluate(text, context) : text;
    public Returned Run()
    {
        try { Nodes(document.Root.Element("inbound").Elements()); }
        catch (Returned result) { return result; }
        catch (Exception)
        {
            context.LastError.Reason = "ExpressionValueEvaluationFailure";
            try { Nodes(document.Root.Element("on-error").Elements()); }
            catch (Returned result) { return result; }
        }
        throw new Exception("Policy did not return a response.");
    }
    void Nodes(IEnumerable<XElement> nodes)
    {
        foreach (var node in nodes)
        {
            switch (node.Name.LocalName)
            {
                case "set-variable": context.Variables[node.Attribute("name").Value] = Value(node.Attribute("value").Value); break;
                case "validate-jwt": context.Variables["caller"] = new Jwt(); break;
                case "choose":
                    var branch = node.Elements("when").FirstOrDefault(n => (bool)Value(n.Attribute("condition").Value)) ?? node.Element("otherwise");
                    if (branch != null) Nodes(branch.Elements());
                    break;
                case "send-request":
                    Calls.Add((string)context.Variables["stage"]);
                    var payload = JObject.Parse((string)Value(node.Element("set-body").Value));
                    var originalText = (string)context.Request.Body.As<JObject>()["text"];
                    var forwardedText = (string)context.Variables["stage"] == "decision" ? (string)payload["state"] : (string)payload["text"];
                    if (forwardedText != originalText) throw new Exception("Original prompt was modified or lost.");
                    if ((string)context.Variables["stage"] == "decision" && payload["questions"] is not JObject)
                        throw new Exception("Decision request is invalid.");
                    context.Variables[node.Attribute("response-variable-name").Value] = responses.Dequeue();
                    break;
                case "return-response":
                    var status = Convert.ToInt32(Value(node.Element("set-status").Attribute("code").Value));
                    throw new Returned(status, JObject.Parse((string)Value(node.Element("set-body").Value)));
            }
        }
    }
}
public static class Program
{
    public static void Main(string[] args)
    {
        var document = XDocument.Load(args[0]);
        var categories = new[] { "claims_fraud_assistance", "coverage_deception", "discriminatory_treatment", "unauthorized_policyholder_data" };
        string Decision(double probability) => new JObject(new JProperty("answers", new JObject(categories.Select(id =>
            new JProperty(id, new JObject(new JProperty("type", "noul"), new JProperty("noul", probability))))))).ToString();
        var safety = new JObject(new JProperty("categoriesAnalysis", new JArray(new[] { "Hate", "SelfHarm", "Sexual", "Violence" }
            .Select(name => new JObject(new JProperty("category", name), new JProperty("severity", 0)))))).ToString();
        int checks = 0;
        void Check(string name, string input, IResponse[] dependencies, int expectedStatus, string outcome, int callCount, string safetyStatus)
        {
            var context = new Context();
            context.Request.Body = new Body(input);
            var interpreter = new Interpreter(document, context, new Queue<IResponse>(dependencies));
            var result = interpreter.Run();
            if (result.Status != expectedStatus || (string)result.Payload["outcome"] != outcome ||
                interpreter.Calls.Count != callCount || (string)result.Payload["contentSafety"]["status"] != safetyStatus)
                throw new Exception($"FAILED {name}: status={result.Status} body={result.Payload} calls={interpreter.Calls.Count}");
            Console.WriteLine($"PASS {name}");
            checks++;
        }
        Check("allow calls Decision then Content Safety", "{\"text\":\"Truthful claim\"}", [new Response(200, Decision(0.1)), new Response(200, safety)], 200, "allowed", 2, "completed");
        foreach (var category in new[] { "Hate", "SelfHarm", "Sexual", "Violence" })
        {
            foreach (var severity in new[] { 4, 5, 6, 7 })
            {
                var general = JObject.Parse(safety);
                general["categoriesAnalysis"].Single(item => (string)item["category"] == category)["severity"] = severity;
                Check($"{category} severity {severity}", "{\"text\":\"Fixture\"}",
                    [new Response(200, Decision(0.1)), new Response(200, general.ToString())],
                    severity >= 5 ? 403 : 200, severity >= 5 ? "blocked_content_safety" : "allowed", 2, "completed");
            }
        }
        foreach (var severity in new JToken[] { new JValue(-1), new JValue(8), new JValue(4.5), new JValue("5"), JValue.CreateNull() })
        {
            var general = JObject.Parse(safety);
            general["categoriesAnalysis"][0]["severity"] = severity;
            Check($"invalid general severity {severity}", "{\"text\":\"Fixture\"}",
                [new Response(200, Decision(0.1)), new Response(200, general.ToString())], 502, "error", 2, "error");
        }
        var duplicateSafety = JObject.Parse(safety);
        duplicateSafety["categoriesAnalysis"][1]["category"] = "Hate";
        Check("duplicate general category fails closed", "{\"text\":\"Fixture\"}",
            [new Response(200, Decision(0.1)), new Response(200, duplicateSafety.ToString())], 502, "error", 2, "error");
        Check("threshold equality blocks before Content Safety", "{\"text\":\"Fixture\"}", [new Response(200, Decision(0.5))], 403, "blocked_custom", 1, "skipped");
        Check("missing Decision answer fails closed", "{\"text\":\"Fixture\"}", [new Response(200, "{\"answers\":{}}")], 502, "error", 1, "skipped");
        Check("invalid Decision JSON fails closed", "{\"text\":\"Fixture\"}", [new Response(200, "invalid-json")], 502, "error", 1, "skipped");
        Check("probability above one fails closed", "{\"text\":\"Fixture\"}", [new Response(200, Decision(1.1))], 502, "error", 1, "skipped");
        Check("timeout or connection failure fails closed", "{\"text\":\"Fixture\"}", [null], 503, "error", 1, "skipped");
        Check("throttling is preserved", "{\"text\":\"Fixture\"}", [new Response(429, "{}")], 429, "error", 1, "skipped");
        Check("HTTP upstream auth failure is technical", "{\"text\":\"Fixture\"}", [new Response(401, "{}")], 502, "error", 1, "skipped");
        Check("upstream timeout maps to 504", "{\"text\":\"Fixture\"}", [new Response(504, "{}")], 504, "error", 1, "skipped");
        Check("later Content Safety failure preserves prior scores", "{\"text\":\"Fixture\"}", [new Response(200, Decision(0.1)), new Response(503, "{}")], 503, "error", 2, "error");
        Check("malformed Content Safety fails", "{\"text\":\"Fixture\"}", [new Response(200, Decision(0.1)), new Response(200, "{}")], 502, "error", 2, "error");
        Check("whitespace input makes no backend calls", "{\"text\":\"   \"}", [], 400, "error", 0, "skipped");
        Check("malformed JSON makes no backend calls", "not-json", [], 400, "error", 0, "skipped");
        Check("extra client policy fields rejected", "{\"text\":\"test\",\"threshold\":0}", [], 400, "error", 0, "skipped");
        Check("text length boundary accepted", new JObject(new JProperty("text", new string('a', 4000))).ToString(), [new Response(200, Decision(0.5))], 403, "blocked_custom", 1, "skipped");
        Check("overlong text rejected", new JObject(new JProperty("text", new string('a', 4001))).ToString(), [], 413, "error", 0, "skipped");
        Check("body byte limit enforced", "{\"text\":\"" + new string('a', 33000) + "\"}", [], 413, "error", 0, "skipped");
        Console.WriteLine($"{checks} policy expression/flow checks passed. Authentication and networking require live APIM.");
    }
}
