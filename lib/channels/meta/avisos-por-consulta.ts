/**
 * AVISOS POR CONSULTA: a rede de segurança dos avisos de qualidade e categoria.
 *
 * Os webhooks da Meta (`message_template_*_update`, `template_category_update`,
 * `phone_number_quality_update`) avisam em segundos — quando chegam. Numa instalação
 * que usa o app de OUTRA empresa, a Meta pode entregá-los no callback do app e não no
 * do CRM. Então o cron de 10 em 10 minutos PERGUNTA, compara com a última resposta e
 * abre o mesmo aviso que o webhook abriria.
 *
 * Os dois caminhos se encontram na mesma Central e no mesmo dedup (organização, tipo,
 * conexão e TÍTULO, que carrega o estado "de → para"): se o webhook já avisou, a
 * consulta cai em `aviso_repetido`; se só a consulta viu, ela avisa.
 *
 * Nada aqui lança. A primeira consulta de um número só REGISTRA o estado (sem "antes"
 * não há mudança), para não abrir uma enxurrada com o que já existia.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

import { avisarStatusDoModelo } from "./aviso-do-modelo";
import {
  avisoDeCategoriaDoModelo,
  avisoDeQualidadeDoModelo,
  avisoDeQualidadeDoNumeroConsultada,
  gravarAvisoDeQualidade,
  type AlvoDoAvisoDeQualidade,
} from "./avisos-de-qualidade";
import { graphBaseUrl } from "./graph-base";
import type { MudancaDeModelo } from "./template-sync";

// ─── Modelos ───────────────────────────────────────────────────────────────

/** Abre os avisos do que mudou em modelo já espelhado. Entrega o que `syncTemplates` quer em `aoMudar`. */
export function abrirAvisosDasMudancasDosModelos(
  admin: SupabaseClient,
  alvo: AlvoDoAvisoDeQualidade,
  wabaId: string,
): (mudancas: MudancaDeModelo[]) => Promise<void> {
  return async (mudancas) => {
    for (const m of mudancas) {
      if (m.status) {
        await avisarStatusDoModelo(
          admin,
          { organizationId: alvo.organizationId, channelSessionId: alvo.channelSessionId },
          {
            templateName: m.name,
            templateLanguage: m.language,
            event: m.status.para,
            reason: m.status.motivo,
          },
        );
      }
      if (m.categoria) {
        await gravarAvisoDeQualidade(
          admin,
          alvo,
          avisoDeCategoriaDoModelo({
            templateName: m.name,
            templateLanguage: m.language,
            anterior: m.categoria.de,
            nova: m.categoria.para,
          }),
        );
      }
      // "Em avaliação" → qualquer coisa é o modelo ganhando nota pela primeira vez, não uma queda.
      if (m.qualidade && m.qualidade.de && m.qualidade.de.toUpperCase() !== "UNKNOWN") {
        await gravarAvisoDeQualidade(
          admin,
          alvo,
          avisoDeQualidadeDoModelo({
            templateName: m.name,
            templateLanguage: m.language,
            anterior: m.qualidade.de,
            nova: m.qualidade.para,
          }),
        );
      }
    }
    logger.info("[avisos-por-consulta] mudanças de modelo avaliadas", {
      organization_id: alvo.organizationId,
      waba_id: wabaId,
      modelos: mudancas.length,
    });
  };
}

// ─── Número ────────────────────────────────────────────────────────────────

/** O último estado conhecido do número, guardado em `channel_sessions.metadata`. */
const CHAVE_DO_ESTADO = "qualidade_oficial";

export interface EstadoDoNumero {
  quality: string | null;
  limit: string | null;
}

export type DesfechoDoNumero =
  "registrado" | "sem_mudanca" | "avisou" | "aviso_repetido" | "sem_resposta";

/** Pergunta à Meta. `null` quando a resposta não presta (rede, token, campo ausente). */
export async function consultarQualidadeDoNumero(input: {
  phoneNumberId: string;
  token: string;
  graphVersion: string;
}): Promise<(EstadoDoNumero & { telefone: string | null }) | null> {
  try {
    const url = `${graphBaseUrl(input.graphVersion)}/${input.phoneNumberId}?fields=display_phone_number,quality_rating,whatsapp_business_manager_messaging_limit`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${input.token}` } });
    if (!res.ok) return null;
    const corpo = (await res.json()) as Record<string, unknown>;
    const texto = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
    const quality = texto(corpo.quality_rating);
    if (!quality) return null;
    return {
      quality,
      limit: texto(corpo.whatsapp_business_manager_messaging_limit),
      telefone: texto(corpo.display_phone_number),
    };
  } catch {
    return null;
  }
}

/**
 * Compara a resposta de agora com a última guardada, avisa se mudou e guarda a nova.
 * A leitura-e-escrita do `metadata` é de um escritor só (o cron), então não há corrida.
 */
export async function verificarQualidadeDoNumero(
  admin: SupabaseClient,
  sessao: { id: string; organizationId: string; metadata: Record<string, unknown> | null },
  agora: EstadoDoNumero & { telefone: string | null },
): Promise<DesfechoDoNumero> {
  try {
    const metadata = sessao.metadata ?? {};
    const antes = (metadata[CHAVE_DO_ESTADO] ?? null) as EstadoDoNumero | null;

    let desfecho: DesfechoDoNumero = "registrado";
    if (antes) {
      const aviso = avisoDeQualidadeDoNumeroConsultada({
        telefone: agora.telefone,
        qualidadeAntes: antes.quality,
        qualidadeAgora: agora.quality,
        limiteAntes: antes.limit,
        limiteAgora: agora.limit,
      });
      if (!aviso) desfecho = "sem_mudanca";
      else {
        const r = await gravarAvisoDeQualidade(
          admin,
          { organizationId: sessao.organizationId, channelSessionId: sessao.id },
          aviso,
        );
        desfecho = r === "aviso_repetido" ? "aviso_repetido" : "avisou";
      }
    }

    if (
      desfecho === "sem_mudanca" &&
      antes?.quality === agora.quality &&
      antes?.limit === agora.limit
    ) {
      return desfecho; // nada a gravar
    }
    const { error } = await admin
      .from("channel_sessions")
      .update({
        metadata: {
          ...metadata,
          [CHAVE_DO_ESTADO]: { quality: agora.quality, limit: agora.limit },
        },
      })
      .eq("id", sessao.id)
      .eq("organization_id", sessao.organizationId);
    if (error) {
      logger.error("[avisos-por-consulta] estado do número não gravado", {
        channel_session_id: sessao.id,
        erro: error.message,
      });
    }
    return desfecho;
  } catch (erro) {
    logger.error("[avisos-por-consulta] número não verificado", {
      channel_session_id: sessao.id,
      erro: erro instanceof Error ? erro.message : String(erro),
    });
    return "sem_resposta";
  }
}
