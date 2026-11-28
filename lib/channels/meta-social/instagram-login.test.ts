import { afterEach, describe, expect, it, vi } from "vitest";

import {
  baseDaGraph,
  modoDaConfiguracao,
  modoDaSessao,
  perfilDoInstagram,
  renovarTokenDoInstagram,
  trocarCodigoDoInstagram,
  urlDeAutorizacaoDoInstagram,
} from "@/lib/channels/meta-social/instagram-login";

afterEach(() => vi.unstubAllGlobals());

describe("modo do login", () => {
  it("sem ID da configuração o modo é o do Instagram; com ele, o unificado", () => {
    expect(modoDaConfiguracao({ loginConfigId: null })).toBe("instagram");
    expect(modoDaConfiguracao({ loginConfigId: "1150" })).toBe("unificado");
  });

  it("a sessão sem o campo (anterior a este modo) é a unificada", () => {
    expect(modoDaSessao({})).toBe("unificado");
    expect(modoDaSessao(null)).toBe("unificado");
    expect(modoDaSessao({ login_modo: "instagram" })).toBe("instagram");
  });

  it("cada modo fala no seu host", () => {
    expect(baseDaGraph("instagram")).toMatch(/^https:\/\/graph\.instagram\.com\/v\d+/);
    expect(baseDaGraph("unificado")).toContain("graph.facebook.com");
    expect(baseDaGraph(undefined)).toContain("graph.facebook.com");
  });
});

describe("urlDeAutorizacaoDoInstagram", () => {
  it("leva o app, a volta, o estado e só os escopos de perfil, mensagens e comentários", () => {
    const u = new URL(urlDeAutorizacaoDoInstagram({ appId: "5822", redirectUri: "https://crm.exemplo/auth/meta-social-return", state: "E.S" }));
    expect(u.origin + u.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe("5822");
    expect(u.searchParams.get("redirect_uri")).toBe("https://crm.exemplo/auth/meta-social-return");
    expect(u.searchParams.get("state")).toBe("E.S");
    expect(u.searchParams.get("scope")).toBe("instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments");
  });
});

describe("trocarCodigoDoInstagram", () => {
  it("troca o código (sem o #_ do fim) pelo token curto e este pelo longo; a chave vai no corpo do POST", async () => {
    const f = vi.fn(async (url: string) =>
      String(url).includes("api.instagram.com")
        ? new Response(JSON.stringify({ access_token: "CURTO", user_id: 1784 }), { status: 200 })
        : new Response(JSON.stringify({ access_token: "LONGO", expires_in: 5184000 }), { status: 200 }),
    );
    vi.stubGlobal("fetch", f);
    const r = await trocarCodigoDoInstagram({ appId: "5822", appSecret: "SEGREDO", redirectUri: "https://x/r", code: "CODIGO123#_" });
    expect(r.accessToken).toBe("LONGO");
    expect(r.userId).toBe("1784");
    expect(r.expiraEm!.getTime()).toBeGreaterThan(Date.now() + 59 * 24 * 3600 * 1000);
    const [, init1] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(init1.body)).toContain("code=CODIGO123");
    expect(String(init1.body)).not.toContain("%23_");
    expect(String(init1.body)).toContain("client_secret=SEGREDO");
  });

  it("a Meta recusa o código: lança sem repetir a chave", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error_message: "Invalid code" }), { status: 400 })));
    const e = await trocarCodigoDoInstagram({ appId: "1", appSecret: "SEGREDO", redirectUri: "https://x/r", code: "C" }).catch((x: unknown) => x as Error);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toMatch(/Invalid code/);
    expect((e as Error).message).not.toContain("SEGREDO");
  });

  it("sem o token de longa duração: recusa (o curto vence em uma hora)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("api.instagram.com")
          ? new Response(JSON.stringify({ access_token: "CURTO", user_id: 1 }), { status: 200 })
          : new Response("{}", { status: 400 }),
      ),
    );
    await expect(trocarCodigoDoInstagram({ appId: "1", appSecret: "S", redirectUri: "https://x/r", code: "C" })).rejects.toThrow(/longa duração/);
  });
});

describe("perfilDoInstagram e renovação", () => {
  it("o id do perfil é o user_id (o que o webhook usa)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ user_id: "1784", id: "999", username: "conta" }), { status: 200 })));
    expect(await perfilDoInstagram("T")).toMatchObject({ id: "1784", username: "conta" });
  });

  it("renovar devolve o novo token; recusa vira null (nunca lança)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ access_token: "NOVO", expires_in: 5184000 }), { status: 200 })));
    expect((await renovarTokenDoInstagram("T"))?.accessToken).toBe("NOVO");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 400 })));
    expect(await renovarTokenDoInstagram("T")).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("rede"); }));
    expect(await renovarTokenDoInstagram("T")).toBeNull();
  });
});
