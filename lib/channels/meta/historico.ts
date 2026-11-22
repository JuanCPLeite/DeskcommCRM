/**
 * Importa o HISTÓRICO de conversas que a Meta entrega a um número em coexistência.
 *
 * Quando a empresa conecta pelo app WhatsApp Business, a Meta pode mandar — uma
 * vez, dentro de 24 h do pedido `smb_app_data` — as conversas que o celular já
 * tinha. Chegam pelo webhook `history`, em pedaços, e eram descartadas: a equipe
 * abria o contato e a conversa começava no dia da conexão.
 *
 * ─── O passado não é mensagem nova ──────────────────────────────────────────
 * `messages` tem gatilhos de INSERT que acordam o agente, abrem demanda com SLA,
 * mandam push e reabrem conversa. Importar 2.000 mensagens por `ingestMetaInbound`
 * faria a IA responder quem falou há meses. Por isso este caminho NÃO reusa a
 * ingestão ao vivo: ele segue o importador do canal por QR
 * (`lib/channels/historico/rodada.ts`, #999), que a migration 0760 já blindou:
 *
 *   - toda linha leva `metadata.historico_importado = 'true'` (TEXTO, não booleano
 *     — é a chave que os gatilhos leem) e os gatilhos a deixam passar calados;
 *   - a conversa que NASCE aqui nasce `closed` e sem dono
 *     (`fn_upsert_wa_conversation_importada`), então nada entra na fila de
 *     roteamento. A que já existia volta intocada;
 *   - não há `marcarConversaComMensagem` (janela de 24 h, não lidas e prévia são de
 *     mensagem VIVA), nem `aplicarEfeitosPosEntrada` (lead, agente, opt-out), nem
 *     pausa da IA. Uma mensagem nova de verdade, depois, reabre normalmente.
 *
 * ─── O contrato com quem pediu para sair (LGPD) ─────────────────────────────
 * O celular guarda conversas de quem já foi apagado a pedido. Titular apagado e
 * ficha anonimizada ficam de fora, e a pergunta falha FECHADA: na dúvida, o fio
 * não entra.
 *
 * ─── Idempotência ───────────────────────────────────────────────────────────
 * A Meta reentrega o que não recebe 2xx, e uma mensagem pode já ter entrado ao
 * vivo (o eco do app): o `wamid` é consultado antes e o 23505 do insert é
 * contado como "já existia".
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { ehNumeroInternoDeAviso } from "@/lib/escalacao/numero-interno-de-aviso";
import { logger } from "@/lib/logger";
import { nomeDeArquivoLimpo } from "@/lib/messaging/media/nome-de-arquivo";
import { buscaEmLotes } from "@/lib/supabase/em-lotes";

import { encontrarContatoPorTelefoneComAnonimizacao } from "../contato-por-telefone";
import { canonicalPhoneBR } from "../phone-variants";
import type { ChannelTenantScope } from "../types";
import { sessionByPhoneNumberId } from "./ingest";
import {
  MOTIVO_CONTATO_ANONIMIZADO,
  MOTIVO_TITULAR_APAGADO,
  perguntarTitularesApagadosNoLote,
  type ApagadosNoLote,
} from "./titular-apagado";
import type { HistoryChunkEvent, HistoryMessage } from "./webhook";

type Admin = SupabaseClient;

export type HistoricoOutcome =
  | {
      status: "imported";
      gravadas: number;
      /** Já estavam no CRM (entraram ao vivo, ou o pedaço foi reentregue). */
      existentes: number;
      /** Conversas que ficaram de fora de propósito (LGPD, número interno de avisos). */
      conversasIgnoradas: number;
      /** Conversas que deram erro ao gravar — o pedaço NÃO é reentregue pela Meta. */
      conversasComFalha: number;
    }
  /** A Meta disse que não vai entregar (o dono não aceitou compartilhar, janela vencida…). */
  | { status: "declined"; code: number | null }
  | { status: "no_session" }
  | { status: "failed"; reason: string };

/** Marca que os gatilhos de `messages` leem — TEXTO `'true'`, não booleano (0760). */
const HISTORICO_IMPORTADO = "true";

/** Só imagem e áudio têm mídia buscada — o mesmo escopo do importador do canal por QR. */
const COM_MIDIA_BAIXADA = new Set(["image", "audio"]);
const COM_MIDIA_FORA = new Set(["video", "document", "sticker"]);

/**
 * Orçamento, em bytes codificados, dos `wamid` de UMA consulta de deduplicação
 * (o Kong devolve 414 acima de 8.192 B de URL) — o mesmo número do importador por QR.
 */
const BYTES_DE_WAMIDS_POR_CONSULTA = 4096;

function mensagemDeErro(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

/**
 * O estado de entrega que a conversa mostra. Recebida é sempre `delivered` (chegou
 * ao celular da empresa); a enviada leva o que a Meta contou. `ERROR` vira `failed`
 * porque é a verdade — e nada reenvia (o cron `recover-stuck-messages` não toca em
 * `failed`).
 */
export function statusDaMensagemImportada(m: Pick<HistoryMessage, "direction" | "status">): string {
  if (m.direction === "inbound") return "delivered";
  switch ((m.status ?? "").toUpperCase()) {
    case "READ":
    case "PLAYED":
      return "read";
    case "DELIVERED":
      return "delivered";
    case "ERROR":
      return "failed";
    default:
      return "sent";
  }
}

interface LinhaImportada {
  organization_id: string;
  conversation_id: string;
  channel_session_id: string;
  contact_id: string;
  direction: "inbound" | "outbound";
  status: string;
  sent_via: "external_device";
  type: string;
  body: string | null;
  external_id: string;
  media_url: string | null;
  media_mime: string | null;
  sent_at: string;
  metadata: Record<string, unknown>;
}

/** A linha de `messages` de uma mensagem do passado. Pura — a prova de que a chave dos gatilhos vai junto. */
export function linhaDoHistorico(
  m: HistoryMessage,
  ctx: { orgId: string; sessionId: string; contactId: string; conversationId: string },
): LinhaImportada {
  const nomeDoArquivo = nomeDeArquivoLimpo(m.media?.filename);
  const baixada = COM_MIDIA_BAIXADA.has(m.type);
  const fora = COM_MIDIA_FORA.has(m.type);
  // `solicitada` (e não `pendente`): o pedido de guardar a mídia sai logo em seguida.
  const statusDaMidia = baixada ? (m.media ? "solicitada" : "indisponivel") : fora ? "fora_do_escopo" : null;
  return {
    organization_id: ctx.orgId,
    conversation_id: ctx.conversationId,
    channel_session_id: ctx.sessionId,
    contact_id: ctx.contactId,
    direction: m.direction,
    status: statusDaMensagemImportada(m),
    sent_via: "external_device",
    type: m.type,
    body: m.type === "contact" ? (m.sharedContact?.name ?? m.text) : m.text,
    external_id: m.externalId,
    media_url: baixada && m.media ? `meta-media:${m.media.id}` : null,
    media_mime: m.media?.mime ?? null,
    sent_at: m.sentAt.toISOString(),
    metadata: {
      historico_importado: HISTORICO_IMPORTADO,
      importacao_origem: "meta_coexistencia",
      ...(statusDaMidia ? { media_status: statusDaMidia } : {}),
      ...(baixada && m.media ? { meta_media_id: m.media.id, voice: m.media.voice } : {}),
      ...(nomeDoArquivo ? { media_filename: nomeDoArquivo } : {}),
      ...(m.sharedContact ? { shared_contact: m.sharedContact } : {}),
      ...(m.rawType ? { raw_type: m.rawType } : {}),
    },
  };
}

interface ResultadoDoFio {
  gravadas: number;
  existentes: number;
  /** Fio que ficou de fora de propósito; `undefined` = entrou. */
  ignorado?: string;
}

/** Uma conversa (um cliente) do pedaço: contato, conversa e mensagens. LANÇA em erro de banco. */
async function importarFio(
  admin: Admin,
  ctx: { orgId: string; sessionId: string; apagados: ApagadosNoLote | null },
  contato: string,
  mensagens: HistoryMessage[],
): Promise<ResultadoDoFio> {
  const telefone = `+${contato.replace(/\D/g, "")}`;
  const canonico = canonicalPhoneBR(telefone);

  // O número interno de avisos não vira cliente — mesma guarda de todo caminho de entrada.
  if (await ehNumeroInternoDeAviso(admin, ctx.orgId, { kind: "phone", phone: telefone, lid: null })) {
    return { gravadas: 0, existentes: 0, ignorado: "numero_interno_de_aviso" };
  }

  // Titular apagado a pedido NÃO volta pelo histórico do celular. Em lote a pergunta
  // já foi feita uma vez; sem o conjunto, pergunta por este número. Erro ou resposta
  // que não é sim/não LANÇA: importar na dúvida desfaria o apagamento.
  if (ctx.apagados) {
    if (ctx.apagados.has(canonico)) {
      return { gravadas: 0, existentes: 0, ignorado: MOTIVO_TITULAR_APAGADO };
    }
  } else {
    const { data: apagado, error } = await admin.rpc(
      "fn_titular_apagado_a_pedido" as never,
      { p_org: ctx.orgId, p_telefone: canonico, p_lid: null } as never,
    );
    if (error || typeof apagado !== "boolean") {
      throw new Error(`titular_apagado: ${error?.message ?? "resposta sem booleano"}`);
    }
    if (apagado) return { gravadas: 0, existentes: 0, ignorado: MOTIVO_TITULAR_APAGADO };
  }

  // A ficha já anonimizada também não recebe nada de volta (a anonimização zera o
  // telefone, e o upsert criaria uma ficha nova com o número).
  const existente = await encontrarContatoPorTelefoneComAnonimizacao(admin, ctx.orgId, contato);
  if (existente?.is_anonymized) {
    return { gravadas: 0, existentes: 0, ignorado: MOTIVO_CONTATO_ANONIMIZADO };
  }
  const phone = existente?.phone_number ? canonicalPhoneBR(existente.phone_number) : canonico;

  const { data: contactId, error: erroContato } = await admin.rpc(
    "fn_upsert_wa_contact" as never,
    {
      p_org: ctx.orgId,
      p_kind: "phone",
      p_phone: phone,
      p_lid: null,
      p_chat_id: contato,
      // O histórico não traz o perfil do cliente, e um nome errado congelaria no `coalesce`.
      p_notify: null,
    } as never,
  );
  if (erroContato || !contactId) throw new Error(`contato: ${erroContato?.message ?? "sem id"}`);

  // `last_message_at` só vale no NASCIMENTO da conversa: sem ele a Inbox jogaria a
  // conversa importada para o fim da lista. A que já existia volta intocada.
  const maisNova = mensagens.reduce((a, m) => (m.sentAt > a ? m.sentAt : a), mensagens[0]!.sentAt);
  const { data: conversationId, error: erroConversa } = await admin.rpc(
    "fn_upsert_wa_conversation_importada" as never,
    {
      p_org: ctx.orgId,
      p_contact: contactId as string,
      p_session: ctx.sessionId,
      p_last_message_at: Number.isNaN(maisNova.getTime()) ? null : maisNova.toISOString(),
    } as never,
  );
  if (erroConversa || !conversationId) throw new Error(`conversa: ${erroConversa?.message ?? "sem id"}`);

  // Deduplica pelo `wamid`: pode ter entrado ao vivo, ou o pedaço pode ser reentrega.
  const unicos = [...new Set(mensagens.map((m) => m.externalId))];
  const { data: achadas, error: erroConsulta } = await buscaEmLotes<{ external_id: string | null }>(
    unicos,
    (lote) =>
      admin
        .from("messages")
        .select("external_id")
        .eq("organization_id", ctx.orgId)
        .in("external_id", lote),
    { bytesPorLote: BYTES_DE_WAMIDS_POR_CONSULTA },
  );
  if (erroConsulta) throw new Error(`messages_consulta: ${erroConsulta.message}`);
  const jaTem = new Set(achadas.map((a) => a.external_id));

  let existentes = 0;
  const vistos = new Set<string>();
  const novas: LinhaImportada[] = [];
  for (const m of mensagens) {
    if (jaTem.has(m.externalId) || vistos.has(m.externalId)) {
      existentes += 1;
      continue;
    }
    vistos.add(m.externalId);
    novas.push(
      linhaDoHistorico(m, {
        orgId: ctx.orgId,
        sessionId: ctx.sessionId,
        contactId: contactId as string,
        conversationId: conversationId as string,
      }),
    );
  }
  if (novas.length === 0) return { gravadas: 0, existentes };

  const gravadas = await inserirLinhas(admin, novas);
  existentes += novas.length - gravadas.length;

  // Mídia guardada no storage pelo worker (o mesmo `media.persist_requested` do ao
  // vivo). Por causa da chave do histórico o worker NÃO deriva efeito de mensagem.
  for (const g of gravadas) {
    if (!g.media_url) continue;
    const { error: erroEmit } = await admin.rpc("emit_event" as never, {
      p_event_type: "media.persist_requested",
      p_entity_kind: "message",
      p_entity_id: g.id,
      p_payload: { message_id: g.id, conversation_id: conversationId as string },
      p_metadata: { source: "meta_historico" },
      p_organization_id: ctx.orgId,
    } as never);
    if (erroEmit) {
      logger.warn("[meta.historico] emit media.persist_requested falhou", {
        organization_id: ctx.orgId,
        erro: erroEmit.message,
      });
    }
  }
  return { gravadas: gravadas.length, existentes };
}

/**
 * Insere em lote; se o lote bater num 23505 (corrida com o webhook ao vivo entre a
 * consulta e o insert), cada linha vai sozinha e a repetida sai do resultado.
 */
async function inserirLinhas(
  admin: Admin,
  linhas: LinhaImportada[],
): Promise<Array<{ id: string; media_url: string | null }>> {
  const comMidia = new Map(linhas.map((l) => [l.external_id, l.media_url]));
  const { data, error } = await admin.from("messages").insert(linhas as never).select("id, external_id");
  if (!error) {
    return ((data ?? []) as Array<{ id: string; external_id: string }>).map((r) => ({
      id: r.id,
      media_url: comMidia.get(r.external_id) ?? null,
    }));
  }
  if ((error as { code?: string }).code !== "23505") {
    throw new Error(`messages_insert: ${mensagemDeErro(error)}`);
  }
  const entraram: Array<{ id: string; media_url: string | null }> = [];
  for (const l of linhas) {
    const { data: um, error: erroUm } = await admin
      .from("messages")
      .insert(l as never)
      .select("id")
      .maybeSingle();
    if (!erroUm && um) entraram.push({ id: (um as { id: string }).id, media_url: l.media_url });
    else if (erroUm && (erroUm as { code?: string }).code !== "23505") {
      throw new Error(`messages_insert: ${mensagemDeErro(erroUm)}`);
    }
  }
  return entraram;
}

/** O que a Meta disse, em uma linha que o operador entende. Sem conteúdo de conversa. */
function textoDaRecusa(erro: { code: number | null; title: string | null }): string {
  const cod = erro.code !== null ? ` (código ${erro.code})` : "";
  const titulo = erro.title ? `: ${erro.title}` : "";
  return `A Meta não entregou o histórico${cod}${titulo}`.slice(0, 300);
}

/**
 * Grava o andamento em `channel_session_meta_signup` — o que a tela mostra. O
 * percentual só SOBE (os pedaços chegam fora de ordem) e a contagem é feita na
 * tabela, não somada, para dois pedaços simultâneos não perderem mensagens.
 * Devolve se esta chamada foi a que fechou o histórico (a auditoria é uma vez só).
 */
async function registrarAndamento(
  admin: Admin,
  args: {
    orgId: string;
    sessionId: string;
    progresso: number | null;
    erro?: string | null;
  },
): Promise<{ fechouAgora: boolean; mensagens: number }> {
  const { data: atual } = await admin
    .from("channel_session_meta_signup")
    .select("historico_progresso, historico_concluido_em")
    .eq("organization_id", args.orgId)
    .eq("channel_session_id", args.sessionId)
    .maybeSingle();
  const antes = atual as { historico_progresso: number | null; historico_concluido_em: string | null } | null;

  const { count } = await admin
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", args.orgId)
    .eq("channel_session_id", args.sessionId)
    .eq("metadata->>historico_importado", HISTORICO_IMPORTADO);
  const mensagens = count ?? 0;

  const progresso =
    args.progresso === null
      ? (antes?.historico_progresso ?? null)
      : Math.max(Math.min(100, Math.max(0, Math.round(args.progresso))), antes?.historico_progresso ?? 0);
  const fechou = !antes?.historico_concluido_em && progresso !== null && progresso >= 100 && !args.erro;
  const agora = new Date().toISOString();

  const { error } = await admin.from("channel_session_meta_signup").upsert(
    {
      channel_session_id: args.sessionId,
      organization_id: args.orgId,
      historico_progresso: progresso,
      historico_mensagens: mensagens,
      historico_atualizado_em: agora,
      ...(fechou ? { historico_concluido_em: agora } : {}),
      // Só escreve o erro quando há um novo: um pedaço bom depois de um ruim não o apaga.
      ...(args.erro ? { historico_erro: args.erro } : {}),
    } as never,
    { onConflict: "channel_session_id" },
  );
  if (error) {
    logger.warn("[meta.historico] não gravou o andamento", {
      organization_id: args.orgId,
      erro: error.message,
    });
  }
  return { fechouAgora: fechou && !error, mensagens };
}

/**
 * Um pedaço do histórico. Nunca lança por conteúdo: o chamador responde 2xx de
 * qualquer jeito (a Meta reentregaria em loop), então falha vira `failed` ou
 * `conversasComFalha` e SOBE ao log e a `historico_erro`.
 */
export async function ingestMetaHistoryChunk(
  admin: Admin,
  e: HistoryChunkEvent,
  dono: ChannelTenantScope,
): Promise<HistoricoOutcome> {
  let sessao: { id: string; organization_id: string } | null;
  try {
    sessao = await sessionByPhoneNumberId(admin, dono.organizationId, e.phoneNumberId);
  } catch (err) {
    return { status: "failed", reason: mensagemDeErro(err) };
  }
  // Sem sessão: o histórico é de um número que não é desta organização.
  if (!sessao) return { status: "no_session" };
  const orgId = sessao.organization_id;

  if (e.erro) {
    await registrarAndamento(admin, { orgId, sessionId: sessao.id, progresso: null, erro: textoDaRecusa(e.erro) });
    return { status: "declined", code: e.erro.code };
  }

  const porContato = new Map<string, HistoryMessage[]>();
  for (const m of e.mensagens) {
    const lista = porContato.get(m.contato);
    if (lista) lista.push(m);
    else porContato.set(m.contato, [m]);
  }

  // A pergunta do titular apagado vale pelo pedaço inteiro: UMA consulta, e não uma
  // por conversa. Se ela falhar, cada fio pergunta sozinho (falha fechada).
  let apagados: ApagadosNoLote | null = null;
  if (porContato.size > 0) {
    const lote = await perguntarTitularesApagadosNoLote(admin, orgId, [...porContato.keys()]);
    if (lote.erro) {
      logger.error("[meta.historico] a pergunta do titular apagado no lote falhou", {
        organization_id: orgId,
        erro: lote.erro,
        conversas_no_pedaco: porContato.size,
      });
    } else {
      apagados = lote.apagados;
    }
  }

  let gravadas = 0;
  let existentes = 0;
  let conversasIgnoradas = 0;
  let conversasComFalha = 0;
  for (const [contato, mensagens] of porContato) {
    try {
      const r = await importarFio(admin, { orgId, sessionId: sessao.id, apagados }, contato, mensagens);
      gravadas += r.gravadas;
      existentes += r.existentes;
      if (r.ignorado) conversasIgnoradas += 1;
    } catch (err) {
      // Uma conversa com erro não derruba as outras do pedaço. O telefone NÃO vai
      // ao log: é PII do cliente.
      conversasComFalha += 1;
      logger.error("[meta.historico] conversa não importada", {
        organization_id: orgId,
        erro: mensagemDeErro(err),
      });
    }
  }

  const andamento = await registrarAndamento(admin, {
    orgId,
    sessionId: sessao.id,
    progresso: e.progress,
    erro:
      conversasComFalha > 0
        ? `${conversasComFalha} conversa(s) do histórico não foram gravadas — a Meta não reenvia o pedaço.`
        : null,
  });
  if (andamento.fechouAgora) {
    await audit({
      action: "channel.official_history_synced",
      organizationId: orgId,
      resourceType: "channel_session",
      resourceId: sessao.id,
      metadata: { mensagens: andamento.mensagens },
    });
  }

  return { status: "imported", gravadas, existentes, conversasIgnoradas, conversasComFalha };
}
