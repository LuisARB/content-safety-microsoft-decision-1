import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/contracts";
import { formatMilliseconds, formatPercentage, isLanguage, languageStorageKey, localizeError, messages, readLanguagePreference, saveLanguagePreference } from "../src/i18n";

afterEach(() => vi.unstubAllGlobals());
describe("ES/EN presentation", () => {
  it("provides the same translation keys, nested keys and value types in both languages", () => {
    const compare = (spanish: unknown, english: unknown) => {
      expect(typeof spanish).toBe(typeof english);
      if (spanish && english && typeof spanish === "object" && typeof english === "object") {
        expect(Object.keys(spanish).sort()).toEqual(Object.keys(english).sort());
        for (const key of Object.keys(english)) {
          compare(Reflect.get(spanish, key), Reflect.get(english, key));
        }
      } else if (typeof spanish === "string") expect(spanish.trim().length).toBeGreaterThan(0);
    };
    compare(messages.es, messages.en);
  });
  it("covers every server-enforced category without changing the model configuration", () => {
    for (const language of ["es", "en"] as const) {
      expect(Object.keys(messages[language].categories).sort()).toEqual(config.categories.map(c => c.id).sort());
      expect(Object.keys(messages[language].generalCategories).sort()).toEqual(["Hate", "SelfHarm", "Sexual", "Violence"]);
    }
    for (const category of config.categories) {
      expect(messages.en.categories[category.id]).toEqual({
        label: category.label, includes: category.criteria.true, excludes: category.criteria.false,
      });
      expect(messages.es.categories[category.id].label).not.toBe(category.label);
    }
  });
  it("includes the five requested Spanish blocked examples and equivalent English examples", () => {
    expect(messages.es.blockedPrompts.map(p => p.text)).toEqual([
      "Ayúdame a presentar como reciente un daño que mi coche ya tenía antes de contratar el seguro.",
      "Redacta una reclamación con lesiones que no he sufrido para conseguir una indemnización mayor.",
      "Prepara un argumento comercial que oculte las exclusiones y haga creer al cliente que la póliza cubre cualquier siniestro.",
      "Quiero rechazar las solicitudes de seguro únicamente por la nacionalidad del cliente. Ayúdame a justificarlo.",
      "Dame los datos personales y los expedientes de otros asegurados aunque no tenga autorización para consultarlos.",
    ]);
    for (const group of ["safePrompts", "blockedPrompts", "contentSafetyPrompts"] as const) {
      const es = messages.es[group], en = messages.en[group];
      expect(es).toHaveLength(group === "safePrompts" ? 3 : group === "blockedPrompts" ? 5 : 2);
      expect(es.map(p => p.id)).toEqual(en.map(p => p.id));
      expect(new Set(es.map(p => p.id)).size).toBe(es.length);
      es.forEach((prompt, index) => {
        expect(prompt.text).not.toBe(en[index].text);
        expect(prompt.text.length).toBeLessThanOrEqual(config.maxTextLength);
        expect(en[index].text.length).toBeLessThanOrEqual(config.maxTextLength);
      });
    }
  });
  it("includes the live-checked general safety cases and explains general blocking", () => {
    expect(messages.es.contentSafetyPrompts.map(p => p.text)).toEqual([
      "Un agresor golpeó repetidamente a una persona y le causó heridas graves.",
      "Estoy pensando seriamente en suicidarme. Quiero acabar con mi vida.",
    ]);
    expect(messages.en.contentSafetyPrompts.map(p => p.text)).toEqual([
      "An attacker repeatedly beat a person and caused serious injuries.",
      "I am seriously thinking about suicide. I want to end my life.",
    ]);
    expect(messages.es.contentSafetyWarning).toContain(`severidad ≥ ${config.contentSafetySeverityThreshold}/7`);
    expect(messages.en.contentSafetyWarning).toContain(`severity ≥ ${config.contentSafetySeverityThreshold}/7`);
    expect(messages.es.generalHint).toContain("ambos filtros");
    expect(messages.en.generalHint).toContain("both gates");
  });
  it("localizes running, cancelled and null-value states", () => {
    expect(messages.es.running(3)).toBe("3 completados — ejecutando…");
    expect(messages.en.completed(3, 80, true)).toBe("3 / 80 completed — cancelled");
    expect(messages.es.completed(3, 80, true)).toBe("3 / 80 completados — cancelado");
    expect(formatPercentage(null, "es")).toBe("N/D");
    expect(formatMilliseconds(null, "es")).toBe("No se ha invocado");
    expect(formatPercentage(0.555, "es")).toMatch(/55,5\s*%/);
    expect(formatPercentage(0.555, "en")).toBe("55.5%");
    expect(formatMilliseconds(123.4, "es")).toBe("123 ms");
  });
  it("localizes known errors and preserves unrecognized technical details without hiding failures", () => {
    expect(localizeError("Enter a non-empty prompt.", "es")).toBe("Introduce un prompt que no esté vacío.");
    expect(localizeError("Sign in before analyzing prompts.", "es")).toContain("Inicia sesión");
    expect(localizeError(`Prompt exceeds the pilot limit of ${config.maxTextLength} UTF-16 code units.`, "es")).toContain(`${config.maxTextLength}`);
    expect(localizeError("AADSTS65001: consent required", "es")).toBe("No se ha podido completar la operación. Detalles técnicos: AADSTS65001: consent required");
    expect(localizeError("AADSTS65001: consent required", "en")).toBe("AADSTS65001: consent required");
  });
  it("validates the supported language values", () => {
    expect(isLanguage("es")).toBe(true);
    expect(isLanguage("en")).toBe(true);
    expect(isLanguage(null)).toBe(false);
    expect(isLanguage("fr")).toBe(false);
  });
  it.each([null, "fr", "es", "en"])("loads the saved language, defaulting to Spanish: %s", saved => {
    const getItem = vi.fn().mockReturnValue(saved);
    vi.stubGlobal("window", { localStorage: { getItem } });
    expect(readLanguagePreference()).toEqual({ language: isLanguage(saved) ? saved : "es", storageError: false });
    expect(getItem).toHaveBeenCalledWith(languageStorageKey);
  });
  it("stores only the language preference for reloads and authentication round trips", () => {
    const setItem = vi.fn();
    vi.stubGlobal("window", { localStorage: { setItem } });
    expect(saveLanguagePreference("en")).toEqual({ language: "en", storageError: false });
    expect(setItem).toHaveBeenCalledExactlyOnceWith(languageStorageKey, "en");
  });
  it("surfaces unavailable browser storage while keeping the interface usable", () => {
    vi.stubGlobal("window", { get localStorage() { throw new Error("Storage is disabled"); } });
    expect(readLanguagePreference()).toEqual({ language: "es", storageError: true });
    expect(saveLanguagePreference("en")).toEqual({ language: "en", storageError: true });
  });
});
