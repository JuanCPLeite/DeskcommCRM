/**
 * As chamadas à Graph API que o canal DIRETO de Instagram/Facebook faz ao
 * conectar uma conta. O token do usuário de sistema vai SEMPRE no cabeçalho
 * `Authorization` — nunca na URL, que acaba em log de proxy.
 *
 * As consultas de leitura que podem falhar sem derrubar a conexão (expiração do
 * token, assinatura do webhook) devolvem um valor neutro em vez de lançar: a
 * conta fica conectada e a falha aparece na saúde do canal, onde dá para
 * retentar.
 */
import { graphBaseUrl } from "../meta/graph-base";

/** Os campos de webhook que o canal consome. Os outros chegam e são ignorados. */
export const CAMPOS_DO_WEBHOOK = ["messages", "messaging_postbacks", "comments", "live_comments"] as const;

/** O login não trouxe nenhuma conta do Instagram: a configuração do login não tem a conta marcada. */
export class SemContaAtribuidaError extends Error {
  constructor() {
    super("Nenhuma conta do Instagram foi atribuída a este login.");
    this.name = "SemContaAtribuidaError";
  }
}

function cabecalho(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function lerJson<T>(resposta: Response): Promise<T> {
  return (await resposta.json().catch(() => ({}))) as T;
}

export async function contasAtribuidas(token: string): Promise<{ id: string; username?: string }[]> {
  const resposta = await fetch(`${graphBaseUrl()}/me/assigned_instagram_accounts?fields=id%2Cusername`, {
    headers: cabecalho(token),
    cache: "no-store",
    redirect: "error",
  });
  const corpo = await lerJson<{ data?: { id: string; username?: string }[]; error?: { message?: string } }>(resposta);
  if (!resposta.ok) {
    throw new Error(`Listagem das contas falhou: ${corpo.error?.message ?? `HTTP ${resposta.status}`}`);
  }
  const contas = corpo.data ?? [];
  if (contas.length === 0) throw new SemContaAtribuidaError();
  return contas;
}

export interface PerfilDaConta {
  id: string;
  username: string;
  name?: string;
  profile_picture_url?: string;
}

export async function perfilDaConta(token: string, igId: string, base: string = graphBaseUrl()): Promise<PerfilDaConta> {
  const resposta = await fetch(
    `${base}/${encodeURIComponent(igId)}?fields=id%2Cusername%2Cname%2Cprofile_picture_url`,
    { headers: cabecalho(token), cache: "no-store", redirect: "error" },
  );
  const corpo = await lerJson<Partial<PerfilDaConta> & { error?: { message?: string } }>(resposta);
  if (!resposta.ok || !corpo.id) {
    throw new Error(`Leitura do perfil falhou: ${corpo.error?.message ?? `HTTP ${resposta.status}`}`);
  }
  return { id: corpo.id, username: corpo.username ?? "", name: corpo.name, profile_picture_url: corpo.profile_picture_url };
}

/** Assina o webhook da conta. `false` (e não exceção) quando a Meta recusa: a conexão fica de pé e a falha, visível. */
export async function assinarWebhooks(token: string, igId: string, base: string = graphBaseUrl()): Promise<boolean> {
  try {
    const resposta = await fetch(`${base}/${encodeURIComponent(igId)}/subscribed_apps`, {
      method: "POST",
      headers: { ...cabecalho(token), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ subscribed_fields: CAMPOS_DO_WEBHOOK.join(",") }).toString(),
      cache: "no-store",
      redirect: "error",
    });
    if (!resposta.ok) return false;
    const corpo = await lerJson<{ success?: boolean }>(resposta);
    return Boolean(corpo.success);
  } catch {
    return false;
  }
}

/** Desfaz a assinatura do webhook da conta. `false` (e não exceção) quando a Meta recusa ou não responde. */
export async function desassinarWebhooks(token: string, igId: string, base: string = graphBaseUrl()): Promise<boolean> {
  try {
    const resposta = await fetch(`${base}/${encodeURIComponent(igId)}/subscribed_apps`, {
      method: "DELETE",
      headers: cabecalho(token),
      cache: "no-store",
      redirect: "error",
    });
    if (!resposta.ok) return false;
    const corpo = await lerJson<{ success?: boolean }>(resposta);
    return Boolean(corpo.success);
  } catch {
    return false;
  }
}

/** Quando o token vence; `null` se não vence ou se a consulta falhou. */
export async function expiracaoDoToken(input: {
  token: string;
  appId: string;
  appSecret: string;
}): Promise<Date | null> {
  try {
    const resposta = await fetch(`${graphBaseUrl()}/debug_token`, {
      method: "POST",
      // O token do APP (id|chave) vai no cabeçalho, como o do usuário, e o token
      // inspecionado no CORPO: nenhum dos dois toca a URL.
      headers: { ...cabecalho(`${input.appId}|${input.appSecret}`), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ input_token: input.token }).toString(),
      cache: "no-store",
      redirect: "error",
    });
    if (!resposta.ok) return null;
    const corpo = await lerJson<{ data?: { expires_at?: number } }>(resposta);
    const expira = corpo.data?.expires_at;
    return typeof expira === "number" && expira > 0 ? new Date(expira * 1000) : null;
  } catch {
    return null;
  }
}
