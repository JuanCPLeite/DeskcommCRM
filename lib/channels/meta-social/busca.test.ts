import { beforeEach, describe, expect, it, vi } from "vitest";

const ingest = vi.fn(async (..._a: unknown[]) => ({ status: "processed" }));
vi.mock("@/lib/channels/meta-social/ingest", () => ({ ingestMetaSocial: (...a: unknown[]) => ingest(...a) }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: async () => "TOKEN" }));

import { buscarDmsDaConta, buscarDmsNovas } from "@/lib/channels/meta-social/busca";

const CONTA = "17841400000000001";
const DESDE = new Date("2026-11-28T15:00:00Z");

function conversas(msgs: unknown[]) {
  const f = vi.fn(async () => new Response(JSON.stringify({ data: [{ messages: { data: msgs } }] }), { status: 200 }));
  vi.stubGlobal("fetch", f);
  return f;
}
const sessao = { id: "s1", organizationId: "org-A", igId: CONTA, token: "TOKEN", desde: DESDE };

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("buscarDmsDaConta", () => {
  it("entrega só a DM RECEBIDA e mais nova que a marca; a enviada pela conta e a antiga ficam de fora", async () => {
    conversas([
      { id: "m-nova", message: "oi", created_time: "2026-11-28T15:05:00+0000", from: { id: "999" } },
      { id: "m-antiga", message: "velha", created_time: "2026-11-28T14:00:00+0000", from: { id: "999" } },
      { id: "m-saida", message: "resposta", created_time: "2026-11-28T15:06:00+0000", from: { id: CONTA } },
    ]);
    const r = await buscarDmsDaConta({} as never, sessao);
    expect(ingest).toHaveBeenCalledTimes(1);
    const evento = ingest.mock.calls[0]![1] as { tipo: string; mid: string; participanteId: string; texto: string };
    expect(evento).toMatchObject({ tipo: "mensagem", mid: "m-nova", participanteId: "999", texto: "oi" });
    expect(r.ate.toISOString()).toBe("2026-11-28T15:05:00.000Z");
  });

  it("entrega em ordem cronológica e a marca termina na mais nova", async () => {
    conversas([
      { id: "b", message: "2", created_time: "2026-11-28T15:08:00+0000", from: { id: "999" } },
      { id: "a", message: "1", created_time: "2026-11-28T15:07:00+0000", from: { id: "999" } },
    ]);
    const r = await buscarDmsDaConta({} as never, sessao);
    expect(ingest.mock.calls.map((c) => (c[1] as { mid: string }).mid)).toEqual(["a", "b"]);
    expect(r.ate.toISOString()).toBe("2026-11-28T15:08:00.000Z");
  });

  it("a Meta recusa: lança, e nada é entregue", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 400 })));
    await expect(buscarDmsDaConta({} as never, sessao)).rejects.toThrow(/conversas_http_400/);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("o token vai em Authorization, nunca na URL", async () => {
    const f = conversas([]);
    await buscarDmsDaConta({} as never, sessao);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).not.toContain("TOKEN");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer TOKEN");
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
      vi.fn(async () => {
        n += 1;
        if (n === 1) return new Response("{}", { status: 500 });
        return new Response(JSON.stringify({ data: [{ messages: { data: [{ id: "z", message: "oi", created_time: "2026-11-28T15:30:00+0000", from: { id: "7" } }] } }] }), { status: 200 });
      }),
    );
    const { db, atualizacoes } = dbFalso(linhas);
    const r = await buscarDmsNovas(db, new Date("2026-11-28T15:31:00Z"));
    expect(r).toEqual({ contas: 2, mensagens: 1, falhas: 1 });
    expect(atualizacoes).toHaveLength(1);
  });
});
