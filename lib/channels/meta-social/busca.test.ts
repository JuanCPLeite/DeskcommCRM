import { beforeEach, describe, expect, it, vi } from "vitest";

const ingest = vi.fn(async (..._a: unknown[]) => ({ status: "processed" }));
vi.mock("@/lib/channels/meta-social/ingest", () => ({ ingestMetaSocial: (...a: unknown[]) => ingest(...a) }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: async () => "TOKEN" }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { buscarDmsDaConta, buscarDmsNovas } from "@/lib/channels/meta-social/busca";

const CONTA = "17841400000000001";
const DESDE = new Date("2026-11-28T15:00:00Z");
const sessao = { id: "s1", organizationId: "org-A", igId: CONTA, token: "TOKEN", desde: DESDE };

type Conversa = { id: string; updated_time: string; messages: unknown[] };

/** A Graph em duas etapas: a lista leve (`/{conta}/conversations`) e as mensagens de uma conversa (`/{id}`). */
function graph(conversas: Conversa[]) {
  const f = vi.fn(async (url: string) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/conversations")) {
      return new Response(JSON.stringify({ data: conversas.map(({ id, updated_time }) => ({ id, updated_time })) }), { status: 200 });
    }
    const c = conversas.find((x) => u.pathname.endsWith(`/${x.id}`));
    return new Response(JSON.stringify({ messages: { data: c?.messages ?? [] } }), { status: 200 });
  });
  vi.stubGlobal("fetch", f);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("buscarDmsDaConta", () => {
  it("entrega só a DM RECEBIDA; a enviada pela conta e a muito antiga ficam de fora", async () => {
    graph([
      {
        id: "c1",
        updated_time: "2026-11-28T15:06:00+0000",
        messages: [
          { id: "m-nova", message: "oi", created_time: "2026-11-28T15:05:00+0000", from: { id: "999" } },
          { id: "m-antiga", message: "velha", created_time: "2026-11-28T10:00:00+0000", from: { id: "999" } },
          { id: "m-saida", message: "resposta", created_time: "2026-11-28T15:06:00+0000", from: { id: CONTA } },
        ],
      },
    ]);
    const r = await buscarDmsDaConta({} as never, sessao);
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls[0]![1]).toMatchObject({ tipo: "mensagem", mid: "m-nova", participanteId: "999", texto: "oi" });
    // A conversa foi lida inteira: a marca vai até quando ela mexeu pela última vez.
    expect(r.ate.toISOString()).toBe("2026-11-28T15:06:00.000Z");
  });

  it("só abre as conversas que mexeram depois da marca, da mais antiga para a mais nova", async () => {
    const f = graph([
      { id: "velha", updated_time: "2026-11-28T14:00:00+0000", messages: [] },
      { id: "b", updated_time: "2026-11-28T15:08:00+0000", messages: [{ id: "mb", message: "2", created_time: "2026-11-28T15:08:00+0000", from: { id: "9" } }] },
      { id: "a", updated_time: "2026-11-28T15:07:00+0000", messages: [{ id: "ma", message: "1", created_time: "2026-11-28T15:07:00+0000", from: { id: "8" } }] },
    ]);
    await buscarDmsDaConta({} as never, sessao);
    expect(ingest.mock.calls.map((c) => (c[1] as { mid: string }).mid)).toEqual(["ma", "mb"]);
    const abertas = f.mock.calls.map((c) => new URL(String(c[0])).pathname).filter((p) => !p.endsWith("/conversations"));
    expect(abertas.some((p) => p.endsWith("/velha"))).toBe(false);
  });

  it("a Meta recusa: lança, e nada é entregue", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 400 })));
    await expect(buscarDmsDaConta({} as never, sessao)).rejects.toThrow(/conversas_http_400/);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("o token vai em Authorization, nunca na URL", async () => {
    const f = graph([{ id: "c1", updated_time: "2026-11-28T15:06:00+0000", messages: [] }]);
    await buscarDmsDaConta({} as never, sessao);
    for (const [url, init] of f.mock.calls as unknown as [string, RequestInit][]) {
      expect(String(url)).not.toContain("TOKEN");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer TOKEN");
    }
  });

  it("passou do orçamento de tempo: para de abrir conversas e a marca fica onde parou", async () => {
    graph([
      { id: "a", updated_time: "2026-11-28T15:07:00+0000", messages: [{ id: "ma", message: "1", created_time: "2026-11-28T15:07:00+0000", from: { id: "8" } }] },
      { id: "b", updated_time: "2026-11-28T15:08:00+0000", messages: [{ id: "mb", message: "2", created_time: "2026-11-28T15:08:00+0000", from: { id: "9" } }] },
    ]);
    const r = await buscarDmsDaConta({} as never, sessao, Date.now() - 60_000);
    expect(ingest).not.toHaveBeenCalled();
    expect(r.ate.toISOString()).toBe(DESDE.toISOString());
  });
});

describe("buscarDmsNovas", () => {
  function dbFalso(linhas: unknown[]) {
    const atualizacoes: unknown[] = [];
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      is: () => q,
      not: () => q,
      limit: async () => ({ data: linhas, error: null }),
      update: (v: unknown) => {
        atualizacoes.push(v);
        return { eq: () => ({ eq: async () => ({ error: null }) }) };
      },
    };
    return { db: { from: () => q } as never, atualizacoes };
  }

  it("uma conta com falha não derruba as outras e a marca só avança onde deu certo", async () => {
    const linhas = [
      { id: "s1", organization_id: "org-A", social_account_id: CONTA, social_token_encrypted: "x", metadata: { meta_social_busca_ate: DESDE.toISOString() } },
      { id: "s2", organization_id: "org-B", social_account_id: "17841499999999999", social_token_encrypted: "x", metadata: {} },
    ];
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        n += 1;
        if (n === 1) return new Response("{}", { status: 500 });
        const u = new URL(String(url));
        if (u.pathname.endsWith("/conversations")) {
          return new Response(JSON.stringify({ data: [{ id: "c9", updated_time: "2026-11-28T15:30:00+0000" }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ messages: { data: [{ id: "z", message: "oi", created_time: "2026-11-28T15:30:00+0000", from: { id: "7" } }] } }), { status: 200 });
      }),
    );
    const { db, atualizacoes } = dbFalso(linhas);
    const r = await buscarDmsNovas(db, new Date("2026-11-28T15:31:00Z"));
    expect(r).toEqual({ contas: 2, mensagens: 1, falhas: 1 });
    expect(atualizacoes).toHaveLength(1);
  });
});
