/**
 * RESSINCRONIZA os modelos de UMA conta (WABA) sozinho, para a tela ser espelho do
 * que está na Meta — criado, editado ou apagado em qualquer lugar.
 *
 * ─── Por que existe ────────────────────────────────────────────────────────
 *
 * O espelho (`meta_templates`) só era atualizado por quem clicava em "Sincronizar",
 * e o webhook de status só mexia no `status`. Um modelo criado, editado ou apagado
 * direto no painel da Meta (ou por outro sistema da mesma conta) ficava errado na
 * tela até alguém lembrar de sincronizar. Dois gatilhos agora chamam esta função:
 *
 *   1. o webhook, a cada evento de modelo da conta (status, categoria, qualidade,
 *      conteúdo) — segundos depois da mudança;
 *   2. o cron `modelos-oficiais-sync`, de 10 em 10 minutos — a rede de segurança para o
 *      evento que a Meta não entregou.
 *
 * ─── O que ela garante ─────────────────────────────────────────────────────
 *
 * - NUNCA lança. Quem a chama é o webhook (um throw vira 5xx e a Meta reentrega para
 *   sempre) e o cron (uma conta ruim não derruba as outras).
 * - Trava de rajada: a Meta manda vários eventos juntos (status + categoria + conteúdo
 *   do mesmo modelo). Se o espelho da conta foi sincronizado há poucos segundos, não
 *   pergunta de novo — cada sincronização é uma varredura de páginas na Graph API.
 * - A credencial é a do canal daquela conta, resolvida por `resolveMetaCreds`
 *   (organização à mão). Sem credencial legível, não faz nada e diz por quê.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

import { CHANNEL_PROVIDER_META } from "../capabilities";

import { resolveMetaCreds } from "./credentials";
import { syncTemplates } from "./template-sync";

/** Dentro desta janela o espelho é considerado fresco o bastante para um evento. */
export const JANELA_DA_TRAVA_MS = 20_000;

export type DesfechoDaRessincronizacao =
  "sincronizado" | "recente" | "sem_canal" | "sem_credencial" | "falhou";

export async function ressincronizarModelosDaWaba(
  admin: SupabaseClient,
  alvo: { organizationId: string; wabaId: string },
  opcoes: { ignorarTrava?: boolean; agora?: Date } = {},
): Promise<DesfechoDaRessincronizacao> {
  try {
    const agora = opcoes.agora ?? new Date();

    if (!opcoes.ignorarTrava) {
      const { data: recente } = await admin
        .from("meta_templates")
        .select("synced_at")
        .eq("organization_id", alvo.organizationId)
        .eq("waba_id", alvo.wabaId)
        .order("synced_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const ultima = recente?.synced_at ? new Date(String(recente.synced_at)).getTime() : 0;
      if (ultima && agora.getTime() - ultima < JANELA_DA_TRAVA_MS) return "recente";
    }

    // Qualquer canal ATIVO desta conta serve: os números da mesma WABA compartilham a
    // lista e o token de um deles vale para a conta inteira.
    const { data: canal } = await admin
      .from("channel_sessions")
      .select("meta_phone_number_id")
      .eq("organization_id", alvo.organizationId)
      .eq("meta_waba_id", alvo.wabaId)
      .is("archived_at", null)
      .not("meta_phone_number_id", "is", null)
      .limit(1)
      .maybeSingle();
    const phoneNumberId = canal?.meta_phone_number_id as string | undefined;
    if (!phoneNumberId) return "sem_canal";

    const creds = await resolveMetaCreds(admin, {
      organizationId: alvo.organizationId,
      phoneNumberId,
    });
    if (!creds) return "sem_credencial";

    await syncTemplates({
      organizationId: alvo.organizationId,
      wabaId: alvo.wabaId,
      token: creds.token,
      graphVersion: creds.graphVersion,
    });
    return "sincronizado";
  } catch (erro) {
    logger.error("[modelos.ressincronizar] falhou", {
      organization_id: alvo.organizationId,
      waba_id: alvo.wabaId,
      erro: erro instanceof Error ? erro.message : String(erro),
    });
    return "falhou";
  }
}

/** Teto por rodada do cron: cada conta é uma varredura de páginas na Graph API. */
export const LIMITE_DE_CONTAS_POR_RODADA = 50;

export interface ResumoDaRodada {
  contas: number;
  sincronizadas: number;
  semCredencial: number;
  falhas: number;
}

/**
 * A rede de segurança: refaz o espelho de TODAS as contas oficiais ativas. Roda de 10 em 10 minutos
 * (cron `modelos-oficiais-sync`) e cobre o evento que a Meta não entregou — ou
 * o que foi para o callback de outro sistema. Ignora a trava de rajada de propósito.
 */
export async function ressincronizarTodasAsWabas(
  admin: SupabaseClient,
  /** Organizações paradas (suspensas etc.): o cron não trabalha para elas. */
  orgsParadas: ReadonlySet<string> = new Set(),
): Promise<ResumoDaRodada> {
  const { data } = await admin
    .from("channel_sessions")
    .select("organization_id, meta_waba_id")
    .eq("provider", CHANNEL_PROVIDER_META)
    .is("archived_at", null)
    .not("meta_waba_id", "is", null)
    .limit(500);

  // Uma conta pode ter vários números: uma varredura por (organização, conta).
  const contas = new Map<string, { organizationId: string; wabaId: string }>();
  for (const linha of (data ?? []) as Array<{ organization_id: string; meta_waba_id: string }>) {
    if (orgsParadas.has(linha.organization_id)) continue;
    contas.set(`${linha.organization_id}:${linha.meta_waba_id}`, {
      organizationId: linha.organization_id,
      wabaId: linha.meta_waba_id,
    });
  }

  const resumo: ResumoDaRodada = { contas: 0, sincronizadas: 0, semCredencial: 0, falhas: 0 };
  for (const conta of [...contas.values()].slice(0, LIMITE_DE_CONTAS_POR_RODADA)) {
    resumo.contas += 1;
    const desfecho = await ressincronizarModelosDaWaba(admin, conta, { ignorarTrava: true });
    if (desfecho === "sincronizado") resumo.sincronizadas += 1;
    else if (desfecho === "sem_credencial") resumo.semCredencial += 1;
    else if (desfecho === "falhou") resumo.falhas += 1;
  }
  return resumo;
}
