/**
 * O histórico da coexistência (#4074): o que o parser entende do webhook `history`
 * e o que a importação grava — e, mais importante, o que ela NUNCA faz.
 *
 * O que protege o atendimento é negativo: o passado não acorda o agente, não abre
 * demanda, não reabre conversa, não carimba a janela de 24 h. Aqui isso é provado
 * pela CHAVE que os gatilhos leem (`metadata.historico_importado = 'true'`, texto) e
 * pelas funções que NÃO são chamadas. O corte em si, no banco, é do invariante
 * `tests/invariants/historico-importado-nao-dispara.test.ts` (migration 0760).
 *
 * O que só um número real prova — o formato exato de cada pedaço que a Meta manda —
 * fica para a conexão do primeiro número de teste.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  sessao: vi.fn(),
  lote: vi.fn(),
  interno: vi.fn(),
  anonimizado: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/channels/meta/ingest", () => ({ sessionByPhoneNumberId: h.sessao }));
vi.mock("@/lib/channels/meta/titular-apagado", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  perguntarTitularesApagadosNoLote: h.lote,
}));
vi.mock("@/lib/escalacao/numero-interno-de-aviso", () => ({ ehNumeroInternoDeAviso: h.interno }));
vi.mock("@/lib/channels/contato-por-telefone", () => ({
  encontrarContatoPorTelefoneComAnonimizacao: h.anonimizado,
}));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));

import {
  ingestMetaHistoryChunk,
  linhaDoHistorico,
  statusDaMensagemImportada,
} from "@/lib/channels/meta/historico";
import { parseMetaWebhook, type HistoryChunkEvent, type HistoryMessage } from "@/lib/channels/meta/webhook";

const ORG = "22222222-2222-4222-8222-222222222222";
const SESSAO = "33333333-3333-4333-8333-333333333333";
const PN = "100000000000001";
const CLIENTE_A = "5531998966398";
const CLIENTE_B = "5511987654321";
const NOSSO = "5511912345678";

// ─── o fio ──────────────────────────────────────────────────────────────────

function envelope(history: unknown[]) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "999",
        changes: [
          {
            field: "history",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: NOSSO, phone_number_id: PN },
              history,
            },
          },
        ],
      },
    ],
  };
}

const PEDACO = {
  metadata: { phase: 0, chunk_order: 1, progress: 40 },
  threads: [
    {
      id: CLIENTE_A,
      messages: [
        { from: CLIENTE_A, id: "wamid.IN1", timestamp: "1700000000", type: "text", text: { body: "oi" }, history_context: { status: "READ" } },
        { from: NOSSO, id: "wamid.OUT1", timestamp: "1700000060", type: "text", text: { body: "olá!" }, history_context: { status: "DELIVERED" } },
        { from: CLIENTE_A, id: "wamid.R1", timestamp: "1700000090", type: "reaction", reaction: { message_id: "wamid.OUT1", emoji: "👍" } },
      ],
    },
  ],
};

describe("parseMetaWebhook — campo `history`", () => {
  it("lê o pedaço: andamento, conversa e o sentido de cada mensagem", () => {
    const [e] = parseMetaWebhook(envelope([PEDACO]) as never);
    expect(e).toMatchObject({
      kind: "history_chunk",
      wabaId: "999",
      phoneNumberId: PN,
      phase: 0,
      chunk: 1,
      progress: 40,
      erro: null,
    });
    const ev = e as HistoryChunkEvent;
    // A reação não é mensagem: não há o que gravar no passado.
    expect(ev.mensagens.map((m) => m.externalId)).toEqual(["wamid.IN1", "wamid.OUT1"]);
    // O dono da conversa é o CLIENTE (`threads[].id`), nas duas direções.
    expect(ev.mensagens.every((m) => m.contato === CLIENTE_A)).toBe(true);
    expect(ev.mensagens.map((m) => m.direction)).toEqual(["inbound", "outbound"]);
    expect(ev.mensagens[0]!.sentAt.toISOString()).toBe("2023-11-14T22:13:20.000Z");
    expect(ev.mensagens[1]!.status).toBe("DELIVERED");
  });

  it("o cliente sem o nono dígito no `from` continua sendo o cliente (recebida, não enviada)", () => {
    const [e] = parseMetaWebhook(
      envelope([
        {
          metadata: { progress: 10 },
          threads: [
            { id: CLIENTE_A, messages: [{ from: "553198966398", id: "wamid.X", timestamp: "1700000000", type: "text", text: { body: "x" } }] },
          ],
        },
      ]) as never,
    );
    expect((e as HistoryChunkEvent).mensagens[0]!.direction).toBe("inbound");
  });

  it("tipo fora do vocabulário vira texto com o tipo cru, como a mensagem ao vivo", () => {
    const [e] = parseMetaWebhook(
      envelope([
        {
          metadata: { progress: 10 },
          threads: [{ id: CLIENTE_A, messages: [{ from: CLIENTE_A, id: "wamid.U", timestamp: "1700000000", type: "unsupported" }] }],
        },
      ]) as never,
    );
    expect((e as HistoryChunkEvent).mensagens[0]).toMatchObject({ type: "text", rawType: "unsupported" });
  });

  it("imagem leva o id da mídia e a legenda", () => {
    const [e] = parseMetaWebhook(
      envelope([
        {
          metadata: { progress: 10 },
          threads: [
            { id: CLIENTE_A, messages: [{ from: CLIENTE_A, id: "wamid.I", timestamp: "1700000000", type: "image", image: { id: "med-1", mime_type: "image/jpeg", caption: "olha" } }] },
          ],
        },
      ]) as never,
    );
    expect((e as HistoryChunkEvent).mensagens[0]).toMatchObject({
      type: "image",
      text: "olha",
      media: { id: "med-1", mime: "image/jpeg", voice: false },
    });
  });

  it("a recusa da Meta chega como `erro`, no lugar das conversas", () => {
    const [e] = parseMetaWebhook(
      envelope([{ errors: [{ code: 2593109, title: "History sharing is turned off" }] }]) as never,
    );
    expect(e).toMatchObject({
      kind: "history_chunk",
      mensagens: [],
      erro: { code: 2593109, title: "History sharing is turned off" },
    });
  });

  it("pedaço sem conversas (histórico vazio) é um evento com 0 mensagens, não um erro", () => {
    const [e] = parseMetaWebhook(
      envelope([{ metadata: { phase: 0, chunk_order: 1, progress: 100 }, threads: [] }]) as never,
    );
    expect(e).toMatchObject({ kind: "history_chunk", progress: 100, mensagens: [], erro: null });
  });

  it("lixo no meio não derruba o webhook", () => {
    expect(() => parseMetaWebhook(envelope([null, 3, { threads: "x" }, { threads: [null, { id: 1 }] }]) as never)).not.toThrow();
  });
});

// ─── a linha gravada ────────────────────────────────────────────────────────

function msg(over: Partial<HistoryMessage> = {}): HistoryMessage {
  return {
    externalId: "wamid.A",
    contato: CLIENTE_A,
    direction: "inbound",
    sentAt: new Date("2023-11-14T22:13:20.000Z"),
    type: "text",
    text: "oi",
    media: null,
    status: null,
    ...over,
  };
}
const CTX = { orgId: ORG, sessionId: SESSAO, contactId: "c-1", conversationId: "v-1" };

describe("linhaDoHistorico", () => {
  it("leva a chave que cala os gatilhos — como TEXTO 'true', não booleano", () => {
    const l = linhaDoHistorico(msg(), CTX);
    // `coalesce(new.metadata->>'historico_importado','') = 'true'`: o booleano JSON
    // `true` também vira 'true' no `->>`, mas o contrato do repo é o texto (0686/0760).
    expect(l.metadata.historico_importado).toBe("true");
    expect(l.metadata.importacao_origem).toBe("meta_coexistencia");
  });

  it("a saída é do app do celular, e a organização/sessão/contato vêm do contexto", () => {
    const l = linhaDoHistorico(msg({ direction: "outbound" }), CTX);
    expect(l).toMatchObject({
      direction: "outbound",
      sent_via: "external_device",
      organization_id: ORG,
      channel_session_id: SESSAO,
      contact_id: "c-1",
      conversation_id: "v-1",
      external_id: "wamid.A",
      sent_at: "2023-11-14T22:13:20.000Z",
    });
  });

  it.each([
    ["inbound", null, "delivered"],
    ["inbound", "ERROR", "delivered"],
    ["outbound", "READ", "read"],
    ["outbound", "played", "read"],
    ["outbound", "DELIVERED", "delivered"],
    ["outbound", "SENT", "sent"],
    ["outbound", "PENDING", "sent"],
    ["outbound", null, "sent"],
    ["outbound", "ERROR", "failed"],
  ] as const)("estado de entrega: %s + %s => %s", (direction, status, esperado) => {
    expect(statusDaMensagemImportada({ direction, status })).toBe(esperado);
  });

  it("imagem e áudio guardam o ponteiro da mídia; vídeo, documento e figurinha ficam só como registro", () => {
    const img = linhaDoHistorico(msg({ type: "image", media: { id: "m1", mime: "image/png", voice: false } }), CTX);
    expect(img.media_url).toBe("meta-media:m1");
    expect(img.metadata).toMatchObject({ media_status: "solicitada", meta_media_id: "m1" });

    const aud = linhaDoHistorico(msg({ type: "audio", media: { id: "m2", mime: "audio/ogg", voice: true } }), CTX);
    expect(aud.metadata).toMatchObject({ voice: true });

    const vid = linhaDoHistorico(msg({ type: "video", media: { id: "m3", mime: "video/mp4", voice: false } }), CTX);
    expect(vid.media_url).toBeNull();
    expect(vid.metadata).toMatchObject({ media_status: "fora_do_escopo" });

    const semId = linhaDoHistorico(msg({ type: "image", media: null }), CTX);
    expect(semId.media_url).toBeNull();
    expect(semId.metadata).toMatchObject({ media_status: "indisponivel" });
  });

  it("o cartão de contato grava o nome como corpo e o tipo cru quando o tipo era desconhecido", () => {
    const c = linhaDoHistorico(
      msg({ type: "contact", text: null, sharedContact: { name: "Maria" } as never }),
      CTX,
    );
    expect(c.body).toBe("Maria");
    const u = linhaDoHistorico(msg({ rawType: "order" }), CTX);
    expect(u.metadata.raw_type).toBe("order");
  });
});

// ─── a ingestão ─────────────────────────────────────────────────────────────

interface Cenario {
  jaTem: string[];
  /** Telefones (canônicos) cujo upsert de contato falha. */
  contatoFalhaPara: string[];
  andamentoAtual: { historico_progresso: number | null; historico_concluido_em: string | null } | null;
  total: number;
}

function banco(over: Partial<Cenario> = {}) {
  const c: Cenario = { jaTem: [], contatoFalhaPara: [], andamentoAtual: null, total: 0, ...over };
  const rpcs: Array<{ nome: string; args: Record<string, unknown> }> = [];
  const inserts: Array<Record<string, unknown>[]> = [];
  const upserts: Array<Record<string, unknown>> = [];
  const filtros: Array<[string, string, unknown]> = [];

  const rpc = vi.fn(async (nome: string, args: Record<string, unknown>) => {
    rpcs.push({ nome, args });
    if (nome === "fn_upsert_wa_contact") {
      return c.contatoFalhaPara.includes(String(args.p_phone))
        ? { data: null, error: { message: "boom" } }
        : { data: `contato-${String(args.p_chat_id)}`, error: null };
    }
    if (nome === "fn_upsert_wa_conversation_importada") return { data: `conv-${String(args.p_contact)}`, error: null };
    if (nome === "fn_titular_apagado_a_pedido") return { data: false, error: null };
    return { data: null, error: null };
  });

  const consulta = (tabela: string) => {
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (col: string, v: unknown) => (filtros.push([tabela, col, v]), q),
      in: () => q,
      maybeSingle: async () => ({ data: c.andamentoAtual, error: null }),
      then: (ok: (r: unknown) => unknown, ko?: (e: unknown) => unknown) =>
        Promise.resolve({
          data: c.jaTem.map((external_id) => ({ external_id })),
          count: c.total,
          error: null,
        }).then(ok, ko),
    };
    return q;
  };

  const from = (tabela: string) => {
    if (tabela === "messages") {
      return {
        ...consulta(tabela),
        insert: (linhas: Record<string, unknown> | Record<string, unknown>[]) => {
          const lote = Array.isArray(linhas) ? linhas : [linhas];
          inserts.push(lote);
          const resposta = {
            data: lote.map((l, i) => ({ id: `msg-${inserts.length}-${i}`, external_id: l.external_id })),
            error: null,
          };
          return {
            select: () =>
              Object.assign(Promise.resolve(resposta), {
                maybeSingle: async () => ({ data: resposta.data[0], error: null }),
              }),
          };
        },
      };
    }
    return {
      ...consulta(tabela),
      upsert: async (linha: Record<string, unknown>) => {
        upserts.push(linha);
        return { error: null };
      },
    };
  };

  return { admin: { from, rpc } as never, rpcs, inserts, upserts, filtros, c };
}

function chunk(over: Partial<HistoryChunkEvent> = {}): HistoryChunkEvent {
  return {
    kind: "history_chunk",
    wabaId: "999",
    phoneNumberId: PN,
    phase: 0,
    chunk: 1,
    progress: 40,
    mensagens: [
      msg({ externalId: "wamid.IN1", contato: CLIENTE_A, direction: "inbound" }),
      msg({ externalId: "wamid.OUT1", contato: CLIENTE_A, direction: "outbound", status: "READ", sentAt: new Date("2023-11-14T22:14:20.000Z") }),
    ],
    erro: null,
    ...over,
  };
}

const DONO = { organizationId: ORG };

beforeEach(() => {
  vi.clearAllMocks();
  h.sessao.mockResolvedValue({ id: SESSAO, organization_id: ORG });
  h.lote.mockResolvedValue({ apagados: new Set<string>() });
  h.interno.mockResolvedValue(false);
  h.anonimizado.mockResolvedValue(null);
  h.audit.mockResolvedValue(undefined);
});

describe("ingestMetaHistoryChunk — o que grava", () => {
  it("grava as duas pontas na MESMA conversa, pela irmã que não reabre nem distribui", async () => {
    const b = banco();
    const r = await ingestMetaHistoryChunk(b.admin, chunk(), DONO);

    expect(r).toMatchObject({ status: "imported", gravadas: 2, existentes: 0, conversasIgnoradas: 0, conversasComFalha: 0 });
    expect(b.inserts).toHaveLength(1);
    const linhas = b.inserts[0]!;
    expect(linhas.map((l) => l.direction)).toEqual(["inbound", "outbound"]);
    expect(new Set(linhas.map((l) => l.conversation_id)).size).toBe(1);
    // A conversa nasce `closed` e sem dono; a data de nascimento é a da mais nova.
    const conv = b.rpcs.find((x) => x.nome === "fn_upsert_wa_conversation_importada")!;
    expect(conv.args).toMatchObject({ p_org: ORG, p_session: SESSAO, p_last_message_at: "2023-11-14T22:14:20.000Z" });
  });

  it("toda linha leva a chave que cala os gatilhos de `messages`", async () => {
    const b = banco();
    await ingestMetaHistoryChunk(b.admin, chunk(), DONO);
    for (const l of b.inserts.flat()) {
      expect((l.metadata as Record<string, unknown>).historico_importado).toBe("true");
    }
  });

  it("NUNCA carimba a conversa, resolve contato pela rota do ao vivo, pausa a IA ou emite evento de mensagem", async () => {
    const b = banco();
    await ingestMetaHistoryChunk(b.admin, chunk(), DONO);
    const nomes = b.rpcs.map((x) => x.nome);
    // Janela de 24 h, não lidas e prévia são de mensagem VIVA.
    expect(nomes).not.toContain("fn_mark_conversation_message");
    // A que abre conversa `open` e entra na fila de roteamento.
    expect(nomes).not.toContain("fn_upsert_wa_conversation");
    // Texto não pede guardar mídia, e nada aqui emite evento de mensagem.
    expect(nomes).not.toContain("emit_event");
  });

  it("o nome do cliente NÃO é inventado: o histórico não traz perfil", async () => {
    const b = banco();
    await ingestMetaHistoryChunk(b.admin, chunk(), DONO);
    const contato = b.rpcs.find((x) => x.nome === "fn_upsert_wa_contact")!;
    expect(contato.args).toMatchObject({ p_org: ORG, p_notify: null, p_phone: "+5531998966398" });
  });

  it("uma conversa por cliente", async () => {
    const b = banco();
    await ingestMetaHistoryChunk(
      b.admin,
      chunk({
        mensagens: [
          msg({ externalId: "a1", contato: CLIENTE_A }),
          msg({ externalId: "b1", contato: CLIENTE_B }),
          msg({ externalId: "a2", contato: CLIENTE_A, direction: "outbound" }),
        ],
      }),
      DONO,
    );
    expect(b.rpcs.filter((x) => x.nome === "fn_upsert_wa_conversation_importada")).toHaveLength(2);
    expect(b.inserts.flat()).toHaveLength(3);
  });

  it("o que já entrou (ao vivo, ou pedaço reentregue) é contado como existente e não é gravado de novo", async () => {
    const b = banco({ jaTem: ["wamid.IN1"] });
    const r = await ingestMetaHistoryChunk(b.admin, chunk(), DONO);
    expect(r).toMatchObject({ status: "imported", gravadas: 1, existentes: 1 });
    expect(b.inserts.flat().map((l) => l.external_id)).toEqual(["wamid.OUT1"]);
  });

  it("a mesma mensagem duas vezes no pedaço entra uma só", async () => {
    const b = banco();
    const r = await ingestMetaHistoryChunk(
      b.admin,
      chunk({ mensagens: [msg({ externalId: "dup" }), msg({ externalId: "dup" })] }),
      DONO,
    );
    expect(r).toMatchObject({ gravadas: 1, existentes: 1 });
  });

  it("imagem pede ao worker que guarde o arquivo, com a mesma origem de evento", async () => {
    const b = banco();
    await ingestMetaHistoryChunk(
      b.admin,
      chunk({ mensagens: [msg({ externalId: "img", type: "image", media: { id: "m1", mime: "image/png", voice: false } })] }),
      DONO,
    );
    const emits = b.rpcs.filter((x) => x.nome === "emit_event");
    expect(emits).toHaveLength(1);
    expect(emits[0]!.args).toMatchObject({
      p_event_type: "media.persist_requested",
      p_organization_id: ORG,
      p_metadata: { source: "meta_historico" },
    });
  });

  it("toda consulta ao banco leva a organização (service role não tem RLS)", async () => {
    const b = banco({ jaTem: ["x"] });
    await ingestMetaHistoryChunk(b.admin, chunk(), DONO);
    const tabelas = new Set(b.filtros.map((f) => f[0]));
    for (const t of tabelas) {
      expect(b.filtros.some((f) => f[0] === t && f[1] === "organization_id" && f[2] === ORG)).toBe(true);
    }
  });
});

describe("ingestMetaHistoryChunk — o que NÃO grava", () => {
  it("titular apagado a pedido não volta pelo histórico do celular", async () => {
    h.lote.mockResolvedValue({ apagados: new Set(["+5531998966398"]) });
    const b = banco();
    const r = await ingestMetaHistoryChunk(b.admin, chunk(), DONO);
    expect(r).toMatchObject({ status: "imported", gravadas: 0, conversasIgnoradas: 1 });
    expect(b.inserts).toHaveLength(0);
    expect(b.rpcs.map((x) => x.nome)).not.toContain("fn_upsert_wa_contact");
  });

  it("se a pergunta em lote falha, cada conversa pergunta sozinha — e na dúvida não grava", async () => {
    h.lote.mockResolvedValue({ apagados: new Set<string>(), erro: "rede" });
    const b = banco();
    // A pergunta individual também falha: o fio fica de fora, e o pedaço segue.
    (b.admin as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc.mockImplementation(async (nome: string) =>
      nome === "fn_titular_apagado_a_pedido" ? { data: null, error: { message: "sem resposta" } } : { data: "x", error: null },
    );
    const r = await ingestMetaHistoryChunk(b.admin, chunk(), DONO);
    expect(r).toMatchObject({ status: "imported", gravadas: 0, conversasComFalha: 1 });
    expect(b.inserts).toHaveLength(0);
  });

  it("ficha já anonimizada não recebe nada de volta", async () => {
    h.anonimizado.mockResolvedValue({ id: "c", phone_number: null, is_anonymized: true });
    const b = banco();
    const r = await ingestMetaHistoryChunk(b.admin, chunk(), DONO);
    expect(r).toMatchObject({ gravadas: 0, conversasIgnoradas: 1 });
    expect(b.inserts).toHaveLength(0);
  });

  it("o número interno de avisos não vira cliente", async () => {
    h.interno.mockResolvedValue(true);
    const b = banco();
    const r = await ingestMetaHistoryChunk(b.admin, chunk(), DONO);
    expect(r).toMatchObject({ gravadas: 0, conversasIgnoradas: 1 });
    expect(b.inserts).toHaveLength(0);
  });

  it("número que não é desta organização: nada é gravado", async () => {
    h.sessao.mockResolvedValue(null);
    const b = banco();
    expect(await ingestMetaHistoryChunk(b.admin, chunk(), DONO)).toEqual({ status: "no_session" });
    expect(b.inserts).toHaveLength(0);
  });

  it("falha de banco ao achar a sessão sobe como `failed`, e não como `no_session`", async () => {
    h.sessao.mockRejectedValue(new Error("sessao_do_numero: 500"));
    const b = banco();
    expect(await ingestMetaHistoryChunk(b.admin, chunk(), DONO)).toEqual({
      status: "failed",
      reason: "sessao_do_numero: 500",
    });
  });

  it("uma conversa com erro não derruba as outras do pedaço — e o erro fica visível para quem opera", async () => {
    const b = banco({ contatoFalhaPara: ["+5511987654321"] });
    const r = await ingestMetaHistoryChunk(
      b.admin,
      chunk({ mensagens: [msg({ externalId: "a", contato: CLIENTE_A }), msg({ externalId: "b", contato: CLIENTE_B })] }),
      DONO,
    );
    expect(r).toMatchObject({ gravadas: 1, conversasComFalha: 1 });
    expect(b.upserts.at(-1)).toMatchObject({
      historico_erro: expect.stringContaining("1 conversa(s) do histórico não foram gravadas"),
    });
  });
});

describe("ingestMetaHistoryChunk — o andamento que a tela mostra", () => {
  it("grava percentual e contagem em `channel_session_meta_signup`, da organização certa", async () => {
    const b = banco({ total: 7 });
    await ingestMetaHistoryChunk(b.admin, chunk({ progress: 40 }), DONO);
    expect(b.upserts.at(-1)).toMatchObject({
      channel_session_id: SESSAO,
      organization_id: ORG,
      historico_progresso: 40,
      historico_mensagens: 7,
    });
    expect(b.upserts.at(-1)).not.toHaveProperty("historico_concluido_em");
  });

  it("o percentual só sobe: pedaços chegam fora de ordem", async () => {
    const b = banco({ andamentoAtual: { historico_progresso: 80, historico_concluido_em: null } });
    await ingestMetaHistoryChunk(b.admin, chunk({ progress: 40 }), DONO);
    expect(b.upserts.at(-1)).toMatchObject({ historico_progresso: 80 });
  });

  it("100% fecha o histórico UMA vez, com auditoria só de contagem", async () => {
    const b = banco({ total: 12 });
    await ingestMetaHistoryChunk(b.admin, chunk({ progress: 100 }), DONO);
    expect(b.upserts.at(-1)).toHaveProperty("historico_concluido_em");
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "channel.official_history_synced",
        organizationId: ORG,
        resourceId: SESSAO,
        metadata: { mensagens: 12 },
      }),
    );
  });

  it("um pedaço de 100% reentregue não audita de novo", async () => {
    const b = banco({ andamentoAtual: { historico_progresso: 100, historico_concluido_em: "2026-11-22T00:00:00Z" } });
    await ingestMetaHistoryChunk(b.admin, chunk({ progress: 100 }), DONO);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("100% com conversa que falhou NÃO diz 'concluído'", async () => {
    const b = banco({ contatoFalhaPara: ["+5531998966398"] });
    await ingestMetaHistoryChunk(b.admin, chunk({ progress: 100 }), DONO);
    expect(b.upserts.at(-1)).not.toHaveProperty("historico_concluido_em");
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("a recusa da Meta é gravada com o motivo, sem tocar em mensagem nenhuma", async () => {
    const b = banco();
    const r = await ingestMetaHistoryChunk(
      b.admin,
      chunk({ mensagens: [], erro: { code: 2593109, title: "History sharing is turned off" } }),
      DONO,
    );
    expect(r).toEqual({ status: "declined", code: 2593109 });
    expect(b.inserts).toHaveLength(0);
    expect(b.upserts.at(-1)).toMatchObject({
      historico_erro: "A Meta não entregou o histórico (código 2593109): History sharing is turned off",
    });
  });
});
