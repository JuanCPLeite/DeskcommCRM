import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: async () => "TOKEN" }));

import { VALIDADE_DO_PERFIL_MS, lerPerfilDaConta, perfilDaSessao, perfilVigente } from "@/lib/channels/meta-social/perfil-da-conta";

afterEach(() => vi.unstubAllGlobals());

const GRAPH = { username: "conta", name: "Conta Teste", biography: "bio", profile_picture_url: "https://cdn.exemplo/f.jpg", followers_count: 953970, follows_count: 485, media_count: 4158 };

describe("lerPerfilDaConta", () => {
  it("mapeia os campos da Meta e usa o host e o caminho do modo (me no Instagram, o id no unificado)", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(GRAPH), { status: 200 }));
    vi.stubGlobal("fetch", f);
    const p = await lerPerfilDaConta("TOKEN", "1784", { login_modo: "instagram" });
    expect(p).toMatchObject({ nome: "Conta Teste", usuario: "conta", bio: "bio", seguidores: 953970, seguindo: 485, posts: 4158, foto: "https://cdn.exemplo/f.jpg" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toMatch(/^https:\/\/graph\.instagram\.com\/v[\d.]+\/me\?/);
    expect(String(url)).not.toContain("TOKEN");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer TOKEN");
    await lerPerfilDaConta("TOKEN", "1784", {});
    expect(String((f.mock.calls[1] as unknown as [string])[0])).toContain("graph.facebook.com");
    expect(String((f.mock.calls[1] as unknown as [string])[0])).toContain("/1784?");
  });

  it("foto que não é https vira nula (vai para um <img> da tela)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...GRAPH, profile_picture_url: "javascript:alert(1)" }), { status: 200 })));
    expect((await lerPerfilDaConta("T", "1", {}))!.foto).toBeNull();
  });

  it("a Meta recusa ou cai: null, sem lançar", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 400 })));
    expect(await lerPerfilDaConta("T", "1", {})).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("rede"); }));
    expect(await lerPerfilDaConta("T", "1", {})).toBeNull();
  });
});

describe("perfilVigente", () => {
  it("vale dentro da validade e vence depois dela", () => {
    const agora = Date.now();
    const dentro = { perfil: { atualizadoEm: new Date(agora - 60_000).toISOString() } };
    const fora = { perfil: { atualizadoEm: new Date(agora - VALIDADE_DO_PERFIL_MS - 1000).toISOString() } };
    expect(perfilVigente(dentro, agora)).not.toBeNull();
    expect(perfilVigente(fora, agora)).toBeNull();
    expect(perfilVigente({}, agora)).toBeNull();
  });
});

describe("perfilDaSessao", () => {
  function db() {
    const gravados: unknown[] = [];
    const q: Record<string, unknown> = {
      update: (v: unknown) => (gravados.push(v), q),
      eq: () => q,
      then: (ok: (r: unknown) => unknown) => Promise.resolve({ error: null }).then(ok),
    };
    return { db: { from: () => q } as never, gravados };
  }
  const base = { id: "s1", organizationId: "org-A", igId: "1784", cifrado: "x" };

  it("perfil vigente: devolve sem ir à Meta", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const metadata = { perfil: { ...GRAPH, nome: "Guardado", atualizadoEm: new Date().toISOString() } };
    const r = await perfilDaSessao(db().db, { ...base, metadata });
    expect(r!.nome).toBe("Guardado");
    expect(f).not.toHaveBeenCalled();
  });

  it("perfil vencido: relê, grava na sessão da própria organização e devolve o novo", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(GRAPH), { status: 200 })));
    const { db: banco, gravados } = db();
    const metadata = { login_modo: "instagram", perfil: { nome: "Velho", atualizadoEm: "2020-01-01T00:00:00Z" } };
    const r = await perfilDaSessao(banco, { ...base, metadata });
    expect(r!.nome).toBe("Conta Teste");
    expect(gravados).toHaveLength(1);
    expect((gravados[0] as { metadata: Record<string, unknown> }).metadata.login_modo).toBe("instagram");
  });

  it("a Meta cai: devolve o perfil antigo (melhor que cartão vazio) e não grava nada", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    const { db: banco, gravados } = db();
    const metadata = { perfil: { nome: "Velho", atualizadoEm: "2020-01-01T00:00:00Z" } };
    const r = await perfilDaSessao(banco, { ...base, metadata });
    expect(r!.nome).toBe("Velho");
    expect(gravados).toHaveLength(0);
  });
});
