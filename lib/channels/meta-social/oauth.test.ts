import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ESTADO_DO_PROVEDOR,
  paraEstadoDaMeta,
  trocarCodigo,
  urlDeAutorizacao,
  verificarEstadoDaMeta,
} from "@/lib/channels/meta-social/oauth";

const SEGREDO = "segredo-interno-com-mais-de-dezesseis";
const AGORA = new Date("2026-11-27T12:00:00Z");

afterEach(() => vi.restoreAllMocks());

describe("estado do OAuth (a volta da Meta não traz o cookie)", () => {
  it("ida e volta: devolve a organização e a pessoa que iniciaram", () => {
    const estado = paraEstadoDaMeta({ organizationId: "org-1", userId: "user-1" }, { segredo: SEGREDO, agora: AGORA });
    expect(verificarEstadoDaMeta(estado, { segredo: SEGREDO, agora: AGORA })).toMatchObject({
      organizationId: "org-1",
      userId: "user-1",
    });
  });

  it("recusa estado adulterado, vencido, de outro segredo e lixo — sem lançar", () => {
    const estado = paraEstadoDaMeta({ organizationId: "org-1", userId: "user-1" }, { segredo: SEGREDO, agora: AGORA });
    const adulterado = estado.slice(0, 25) + (estado[25] === "A" ? "B" : "A") + estado.slice(26);
    expect(verificarEstadoDaMeta(adulterado, { segredo: SEGREDO, agora: AGORA })).toBeNull();
    const depois = new Date(AGORA.getTime() + 31 * 60 * 1000);
    expect(verificarEstadoDaMeta(estado, { segredo: SEGREDO, agora: depois })).toBeNull();
    expect(verificarEstadoDaMeta(estado, { segredo: "outro-segredo-com-mais-de-dezesseis", agora: AGORA })).toBeNull();
    expect(verificarEstadoDaMeta("lixo", { segredo: SEGREDO, agora: AGORA })).toBeNull();
    expect(verificarEstadoDaMeta(null, { segredo: SEGREDO, agora: AGORA })).toBeNull();
  });

  it("um estado de OUTRO fluxo (o do parceiro) não serve aqui", async () => {
    const { emitirEstadoDaVolta } = await import("@/lib/channels/estado-da-volta");
    const doParceiro = emitirEstadoDaVolta(
      { organizationId: "org-1", userId: "user-1", profileId: "a".repeat(24) },
      { segredo: SEGREDO, agora: AGORA },
    );
    expect(verificarEstadoDaMeta(doParceiro, { segredo: SEGREDO, agora: AGORA })).toBeNull();
    expect(ESTADO_DO_PROVEDOR).toBe("meta_social");
  });
});

describe("urlDeAutorizacao", () => {
  const url = new URL(
    urlDeAutorizacao({
      appId: "1686546369790015",
      loginConfigId: "1150495034023360",
      redirectUri: "https://crm.exemplo.com/auth/meta-social-return",
      state: "estado-x",
    }),
  );

  it("aponta para o diálogo do login unificado com a configuração, sem scope", () => {
    expect(url.origin + url.pathname).toMatch(/^https:\/\/www\.facebook\.com\/v[\d.]+\/dialog\/oauth$|^https:\/\/www\.facebook\.com\/dialog\/oauth$/);
    expect(url.searchParams.get("client_id")).toBe("1686546369790015");
    expect(url.searchParams.get("config_id")).toBe("1150495034023360");
    expect(url.searchParams.get("redirect_uri")).toBe("https://crm.exemplo.com/auth/meta-social-return");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("estado-x");
    expect(url.searchParams.has("scope")).toBe(false);
  });

  it("nunca leva a chave secreta", () => {
    expect(url.toString()).not.toMatch(/secret/i);
  });
});

describe("trocarCodigo", () => {
  it("troca o código pelo token e manda a chave secreta no corpo da chamada ao servidor, nunca em URL de navegador", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ access_token: "TOKEN" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await trocarCodigo({
      appId: "1",
      appSecret: "SEGREDO-DO-APP-0123456789abcdef",
      redirectUri: "https://crm.exemplo.com/auth/meta-social-return",
      code: "CODIGO",
    });
    expect(r).toEqual({ accessToken: "TOKEN" });
    const chamada = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(chamada[0])).toMatch(/oauth\/access_token/);
    expect(String(chamada[0])).not.toContain("SEGREDO-DO-APP");
    expect(String(chamada[1].body)).toContain("client_secret=SEGREDO-DO-APP-0123456789abcdef");
    vi.unstubAllGlobals();
  });

  it("falha com mensagem útil e sem vazar a chave quando a Meta recusa", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { message: "Invalid verification code format." } }), { status: 400 })),
    );
    await expect(
      trocarCodigo({ appId: "1", appSecret: "SEGREDO-DO-APP-0123456789abcdef", redirectUri: "https://x/y", code: "ruim" }),
    ).rejects.toThrow(/Invalid verification code/);
    await expect(
      trocarCodigo({ appId: "1", appSecret: "SEGREDO-DO-APP-0123456789abcdef", redirectUri: "https://x/y", code: "ruim" }),
    ).rejects.not.toThrow(/SEGREDO-DO-APP/);
    vi.unstubAllGlobals();
  });
});
