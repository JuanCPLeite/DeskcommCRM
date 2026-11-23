/**
 * AVISOS EM TEMPO QUASE REAL do canal OFICIAL DIRETO: qualidade do número,
 * qualidade do modelo e mudança de categoria do modelo (utility ↔ marketing).
 *
 * ─── O que estava invisível ────────────────────────────────────────────────
 *
 * O CRM só sabia do status de revisão do modelo (`aviso-do-modelo.ts`) e, de 5
 * em 5 minutos, de número fora do ar (`lib/channels/health.ts`). A Meta também
 * entrega, em segundos, três eventos que ninguém assinava:
 *
 *   - `phone_number_quality_update`: o número subiu/caiu de qualidade ou de
 *     limite de mensagens. Número sinalizado (FLAGGED) é o prenúncio de bloqueio.
 *   - `message_template_quality_update`: a qualidade do modelo mudou. Modelo que
 *     cai para baixa qualidade acaba pausado e a campanha que dependia dele não sai.
 *   - `template_category_update`: a Meta recategorizou o modelo. Mudar de
 *     utility para marketing muda o PREÇO por mensagem e as regras de envio.
 *
 * ─── Mesmos trilhos do aviso de status, sem kind novo ──────────────────────
 *
 * Os avisos caem na MESMA Central (`agent_inbox_items`), com kinds que já existem
 * e com destino certo: o do número reaproveita `channel_number_alert`, o dos
 * modelos reaproveita `channel_template_review_direct`. Kind novo exigiria
 * migration (CHECK de `agent_inbox_items_kind_check`) sem trazer nada que o título
 * não diga.
 *
 * O título carrega o ESTADO (de → para), então uma volta ao estado anterior é
 * notícia nova e não repetição; a mesma entrega reenviada pela Meta cai no dedup.
 *
 * NUNCA lança — a razão é a de `aviso-do-modelo.ts`: um throw viraria 5xx e a
 * Meta reentregaria o mesmo evento para sempre.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

import type { SeveridadeDoAviso } from "./aviso-do-modelo";

const STR = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export interface AvisoDeQualidade {
  kind: "channel_number_alert" | "channel_template_review_direct";
  severity: SeveridadeDoAviso;
  title: string;
  body: string;
}

// ─── Número ────────────────────────────────────────────────────────────────

export interface QualidadeDoNumeroEvento {
  /** `display_phone_number` como a Meta manda (com `+` e espaços). */
  telefone: string | null;
  /** `UPGRADE` | `DOWNGRADE` | `ONBOARDING` | `FLAGGED` | `UNFLAGGED` | … */
  event: string;
  /** `TIER_1K`, `TIER_10K`, `TIER_UNLIMITED`… */
  limite: string | null;
}

const LIMITES: Record<string, string> = {
  TIER_50: "50 clientes por dia",
  TIER_250: "250 clientes por dia",
  TIER_1K: "1.000 clientes por dia",
  TIER_2K: "2.000 clientes por dia",
  TIER_10K: "10.000 clientes por dia",
  TIER_100K: "100.000 clientes por dia",
  TIER_UNLIMITED: "sem limite diário",
};

function limiteLegivel(limite: string | null): string | null {
  const l = STR(limite);
  if (!l) return null;
  return LIMITES[l.toUpperCase()] ?? null;
}

const EVENTOS_DO_NUMERO: Record<
  string,
  { rotulo: string; severity: SeveridadeDoAviso; frase: string }
> = {
  DOWNGRADE: {
    rotulo: "qualidade caiu",
    severity: "warn",
    frase:
      "A Meta rebaixou o número: a qualidade das mensagens caiu (muitos bloqueios ou denúncias). Reduza disparos e revise os textos antes que ele seja limitado.",
  },
  FLAGGED: {
    rotulo: "sinalizado",
    severity: "critical",
    frase:
      "A Meta SINALIZOU o número por baixa qualidade. Se não melhorar em alguns dias, o limite de envio é reduzido. Pare os disparos e revise a lista e os textos.",
  },
  UPGRADE: {
    rotulo: "limite aumentou",
    severity: "info",
    frase: "A Meta aumentou o limite de envio do número: a qualidade está boa.",
  },
  UNFLAGGED: {
    rotulo: "sinalização removida",
    severity: "info",
    frase: "A Meta removeu a sinalização de qualidade do número. Ele voltou ao normal.",
  },
  ONBOARDING: {
    rotulo: "em ativação",
    severity: "info",
    frase: "O número concluiu a ativação na Meta e já tem seu limite inicial de envio.",
  },
};

export function avisoDeQualidadeDoNumero(ev: QualidadeDoNumeroEvento): AvisoDeQualidade | null {
  const desfecho = EVENTOS_DO_NUMERO[ev.event?.toUpperCase() ?? ""];
  if (!desfecho) return null;
  const limite = limiteLegivel(ev.limite);
  const alvo = STR(ev.telefone) ?? "do canal oficial";
  return {
    kind: "channel_number_alert",
    severity: desfecho.severity,
    title: `Número ${alvo}: ${desfecho.rotulo}${limite ? ` (limite: ${limite})` : ""}`,
    body: [
      desfecho.frase,
      limite ? `Limite atual: ${limite}.` : null,
      "Confira em Conexões › API Oficial.",
    ]
      .filter((l): l is string => !!l)
      .join(" "),
  };
}

// ─── Modelo: categoria ─────────────────────────────────────────────────────

export interface CategoriaDoModeloEvento {
  templateName: string;
  templateLanguage: string;
  anterior: string | null;
  nova: string | null;
}

const CATEGORIAS: Record<string, string> = {
  UTILITY: "utilidade",
  MARKETING: "marketing",
  AUTHENTICATION: "autenticação",
};

function categoriaLegivel(c: string | null): string {
  const cru = STR(c);
  return cru ? (CATEGORIAS[cru.toUpperCase()] ?? cru.toLowerCase()) : "desconhecida";
}

export function avisoDeCategoriaDoModelo(ev: CategoriaDoModeloEvento): AvisoDeQualidade | null {
  const nome = STR(ev.templateName);
  const idioma = STR(ev.templateLanguage);
  const nova = STR(ev.nova);
  if (!nome || !idioma || !nova) return null;
  const virouMarketing = nova.toUpperCase() === "MARKETING";
  return {
    kind: "channel_template_review_direct",
    // Virar marketing muda preço e regras de envio: pede atenção. O contrário
    // (marketing → utilidade) é boa notícia.
    severity: virouMarketing ? "warn" : "info",
    title: `Modelo "${nome}" (${idioma}): categoria ${categoriaLegivel(ev.anterior)} → ${categoriaLegivel(nova)}`,
    body: [
      `A Meta mudou a categoria do modelo de ${categoriaLegivel(ev.anterior)} para ${categoriaLegivel(nova)}.`,
      virouMarketing
        ? "Mensagens de marketing custam mais por envio e seguem regras de consentimento mais rígidas. Revise as campanhas que usam este modelo."
        : "Mensagens desta categoria costumam custar menos por envio.",
      "Confira em Conexões › Modelos.",
    ].join(" "),
  };
}

// ─── Modelo: qualidade ─────────────────────────────────────────────────────

export interface QualidadeDoModeloEvento {
  templateName: string;
  templateLanguage: string;
  anterior: string | null;
  nova: string | null;
}

const QUALIDADES: Record<string, { rotulo: string; severity: SeveridadeDoAviso }> = {
  GREEN: { rotulo: "alta", severity: "info" },
  YELLOW: { rotulo: "média", severity: "warn" },
  RED: { rotulo: "baixa", severity: "critical" },
  UNKNOWN: { rotulo: "em avaliação", severity: "info" },
};

function qualidade(q: string | null) {
  return (
    QUALIDADES[(STR(q) ?? "UNKNOWN").toUpperCase()] ?? {
      rotulo: (STR(q) ?? "desconhecida").toLowerCase(),
      severity: "info" as const,
    }
  );
}

export function avisoDeQualidadeDoModelo(ev: QualidadeDoModeloEvento): AvisoDeQualidade | null {
  const nome = STR(ev.templateName);
  const idioma = STR(ev.templateLanguage);
  if (!nome || !idioma || !STR(ev.nova)) return null;
  const nova = qualidade(ev.nova);
  return {
    kind: "channel_template_review_direct",
    severity: nova.severity,
    title: `Modelo "${nome}" (${idioma}): qualidade ${qualidade(ev.anterior).rotulo} → ${nova.rotulo}`,
    body: [
      `A qualidade do modelo passou de ${qualidade(ev.anterior).rotulo} para ${nova.rotulo}.`,
      nova.severity === "critical"
        ? "Qualidade baixa leva a Meta a PAUSAR o modelo, e a campanha que depende dele deixa de sair. Reescreva o texto ou pare de usá-lo."
        : nova.severity === "warn"
          ? "Se continuar caindo, a Meta pausa o modelo. Vale revisar o texto e a lista de quem recebe."
          : "Nada a fazer.",
      "Confira em Conexões › Modelos.",
    ].join(" "),
  };
}

// ─── Gravação ──────────────────────────────────────────────────────────────

export interface AlvoDoAvisoDeQualidade {
  organizationId: string;
  channelSessionId: string;
}

export type DesfechoDoAvisoDeQualidade = "aviso" | "aviso_repetido" | "sem_aviso" | "aviso_falhou";

/** Grava o aviso na Central com dedup por (org, kind, conexão, título). NUNCA lança. */
export async function gravarAvisoDeQualidade(
  admin: SupabaseClient,
  alvo: AlvoDoAvisoDeQualidade,
  aviso: AvisoDeQualidade | null,
): Promise<DesfechoDoAvisoDeQualidade> {
  if (!aviso) return "sem_aviso";
  try {
    const { data: jaAberto, error: erroDaConsulta } = await admin
      .from("agent_inbox_items")
      .select("id")
      .eq("organization_id", alvo.organizationId)
      .eq("kind", aviso.kind)
      .eq("ref_kind", "channel_session")
      .eq("ref_id", alvo.channelSessionId)
      .eq("title", aviso.title)
      .eq("status", "open")
      .limit(1)
      .maybeSingle();
    if (erroDaConsulta) {
      // Mesma escolha de `aviso-do-modelo.ts`: consulta que falha não é "já existe".
      logger.error("[avisos-de-qualidade] dedup não consultado", {
        organization_id: alvo.organizationId,
        channel_session_id: alvo.channelSessionId,
        erro: erroDaConsulta.message,
      });
    }
    if (jaAberto) return "aviso_repetido";

    const { error } = await admin.from("agent_inbox_items").insert({
      organization_id: alvo.organizationId,
      kind: aviso.kind,
      severity: aviso.severity,
      title: aviso.title,
      body: aviso.body,
      ref_kind: "channel_session",
      ref_id: alvo.channelSessionId,
    });
    if (error) {
      logger.error("[avisos-de-qualidade] aviso não gravado", {
        organization_id: alvo.organizationId,
        channel_session_id: alvo.channelSessionId,
        erro: error.message,
      });
      return "aviso_falhou";
    }
    return "aviso";
  } catch (erro) {
    logger.error("[avisos-de-qualidade] aviso não gravado", {
      organization_id: alvo.organizationId,
      channel_session_id: alvo.channelSessionId,
      erro: erro instanceof Error ? erro.message : String(erro),
    });
    return "aviso_falhou";
  }
}

// ─── Número: por CONSULTA (a rede de segurança do webhook) ─────────────────

export interface QualidadeDoNumeroConsultada {
  telefone: string | null;
  qualidadeAntes: string | null;
  qualidadeAgora: string | null;
  limiteAntes: string | null;
  limiteAgora: string | null;
}

const QUALIDADES_DO_NUMERO: Record<
  string,
  { rotulo: string; ordem: number; severity: SeveridadeDoAviso }
> = {
  GREEN: { rotulo: "alta", ordem: 3, severity: "info" },
  YELLOW: { rotulo: "média", ordem: 2, severity: "warn" },
  RED: { rotulo: "baixa", ordem: 1, severity: "critical" },
};

const ORDEM_DOS_LIMITES = [
  "TIER_50",
  "TIER_250",
  "TIER_1K",
  "TIER_2K",
  "TIER_10K",
  "TIER_100K",
  "TIER_UNLIMITED",
];

/**
 * O aviso de quando o CRM PERGUNTA à Meta e a resposta é diferente da última vez — o
 * mesmo assunto do webhook \`phone_number_quality_update\`, para o caso em que ele não
 * chega. Sem "antes" (primeira consulta) não há mudança: o chamador só registra.
 */
export function avisoDeQualidadeDoNumeroConsultada(
  c: QualidadeDoNumeroConsultada,
): AvisoDeQualidade | null {
  const antes = QUALIDADES_DO_NUMERO[(c.qualidadeAntes ?? "").toUpperCase()];
  const agora = QUALIDADES_DO_NUMERO[(c.qualidadeAgora ?? "").toUpperCase()];
  const qualidadeMudou = !!antes && !!agora && antes.rotulo !== agora.rotulo;

  const iAntes = ORDEM_DOS_LIMITES.indexOf((c.limiteAntes ?? "").toUpperCase());
  const iAgora = ORDEM_DOS_LIMITES.indexOf((c.limiteAgora ?? "").toUpperCase());
  const limiteMudou = iAntes >= 0 && iAgora >= 0 && iAntes !== iAgora;

  if (!qualidadeMudou && !limiteMudou) return null;

  const alvo = STR(c.telefone) ?? "do canal oficial";
  const caiu = (qualidadeMudou && agora!.ordem < antes!.ordem) || (limiteMudou && iAgora < iAntes);
  const partes: string[] = [];
  if (qualidadeMudou) partes.push(`qualidade ${antes!.rotulo} → ${agora!.rotulo}`);
  if (limiteMudou) {
    partes.push(
      `limite ${limiteLegivel(c.limiteAntes) ?? c.limiteAntes} → ${limiteLegivel(c.limiteAgora) ?? c.limiteAgora}`,
    );
  }
  const severity: SeveridadeDoAviso =
    qualidadeMudou && agora!.ordem === 1 ? "critical" : caiu ? "warn" : "info";
  return {
    kind: "channel_number_alert",
    severity,
    title: `Número ${alvo}: ${partes.join(", ")}`,
    body: [
      caiu
        ? "A Meta rebaixou o número (muitos bloqueios ou denúncias costumam ser a causa). Reduza disparos e revise os textos antes que ele seja limitado."
        : "A Meta melhorou a avaliação do número.",
      "Confira em Conexões › API Oficial.",
    ].join(" "),
  };
}
