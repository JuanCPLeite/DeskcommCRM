/**
 * O PERFIL da conta conectada (foto, nome, @, bio, seguidores, seguindo e postagens), para o cartão
 * da tela de Conexões. É lido da Meta com o token da própria conta e guardado em `metadata.perfil`
 * da sessão: os números mudam toda hora e a tela não pode custar uma ida à Meta por abertura, então
 * o perfil só é relido quando passa da validade.
 *
 * A foto fica como o ENDEREÇO que a Meta devolveu (ela o renova a cada leitura). Se o endereço
 * vencer entre duas leituras, a tela cai para as iniciais da conta. Nunca lança.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

import { baseDaGraph, modoDaSessao } from "./instagram-login";

/** Passado este tempo o perfil é lido de novo (seguidores mudam, mas não de minuto em minuto). */
export const VALIDADE_DO_PERFIL_MS = 3 * 60 * 60 * 1000;
const TIMEOUT_MS = 6_000;

export interface PerfilGuardado {
  nome: string | null;
  usuario: string | null;
  bio: string | null;
  foto: string | null;
  seguidores: number | null;
  seguindo: number | null;
  posts: number | null;
  atualizadoEm: string;
}

function numero(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

function texto(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** `https` só: o endereço vai para um `<img>` da tela, e nenhum outro esquema serve. */
function enderecoDeImagem(v: unknown): string | null {
  const t = texto(v);
  if (!t) return null;
  try {
    return new URL(t).protocol === "https:" ? t : null;
  } catch {
    return null;
  }
}

/** O perfil guardado na sessão, se ainda estiver dentro da validade. */
export function perfilVigente(metadata: unknown, agora = Date.now()): PerfilGuardado | null {
  const p = (metadata as Record<string, unknown> | null | undefined)?.perfil as Partial<PerfilGuardado> | undefined;
  if (!p?.atualizadoEm) return null;
  const quando = new Date(p.atualizadoEm).getTime();
  if (Number.isNaN(quando) || agora - quando > VALIDADE_DO_PERFIL_MS) return null;
  return p as PerfilGuardado;
}

/** Lê o perfil na Meta. `null` se a Meta recusar ou cair — a tela mostra o que já tinha. */
export async function lerPerfilDaConta(token: string, igId: string, metadata: unknown): Promise<PerfilGuardado | null> {
  const modo = modoDaSessao(metadata);
  const alvo = modo === "instagram" ? "me" : encodeURIComponent(igId);
  try {
    const resposta = await fetch(
      `${baseDaGraph(modo)}/${alvo}?fields=username,name,biography,profile_picture_url,followers_count,follows_count,media_count`,
      {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!resposta.ok) return null;
    const c = (await resposta.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      nome: texto(c.name),
      usuario: texto(c.username),
      bio: texto(c.biography),
      foto: enderecoDeImagem(c.profile_picture_url),
      seguidores: numero(c.followers_count),
      seguindo: numero(c.follows_count),
      posts: numero(c.media_count),
      atualizadoEm: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * O perfil de uma sessão: o guardado, se vigente; senão relê na Meta e guarda. Quando a releitura falha,
 * devolve o guardado mesmo vencido (melhor números de ontem que cartão vazio). Nunca lança.
 */
export async function perfilDaSessao(
  db: SupabaseClient,
  sessao: { id: string; organizationId: string; igId: string; cifrado: string | null; metadata: Record<string, unknown> | null },
): Promise<PerfilGuardado | null> {
  const vigente = perfilVigente(sessao.metadata);
  if (vigente) return vigente;
  const antigo = ((sessao.metadata ?? {}).perfil as PerfilGuardado | undefined) ?? null;
  try {
    if (!sessao.cifrado) return antigo;
    const token = await decryptWebhookSecret(db, sessao.cifrado);
    if (!token) return antigo;
    const novo = await lerPerfilDaConta(token, sessao.igId, sessao.metadata);
    if (!novo) return antigo;
    await db
      .from("channel_sessions")
      .update({ metadata: { ...(sessao.metadata ?? {}), perfil: novo } })
      .eq("organization_id", sessao.organizationId)
      .eq("id", sessao.id);
    return novo;
  } catch {
    return antigo;
  }
}
