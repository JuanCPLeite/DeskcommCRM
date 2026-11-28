/**
 * O app Meta DESTA INSTALAÇÃO para Instagram/Facebook (conexão direta, login
 * unificado) — espelho declarado de `lib/channels/meta/app.ts`, que faz o mesmo
 * para a API oficial do WhatsApp. Razões que valem aqui, e estão lá por inteiro:
 *
 *  - INSTALAÇÃO, não organização: um app Meta atende N contas de N empresas (modelo
 *    Tech Provider). A organização vem da CONTA conectada, nunca do corpo.
 *  - BANCO PRIMEIRO, `.env` COMO PISO DE ROLLBACK (o kit reverte só a imagem).
 *  - O PAR (chave secreta + token de verificação) sai INTEIRO de uma fonte só: a
 *    chave de um app com o token de outro faz o handshake passar e toda entrega
 *    morrer em 401. Os dois identificadores (ID do app e da configuração do login)
 *    são públicos e resolvem campo a campo.
 *  - NUNCA LANÇA: é chamada a cada entrega da Meta; um throw é 500 e a Meta
 *    reentrega em backoff um evento que nunca vai melhorar.
 */

import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

export interface AppSocialDaMetaEmVigor {
  readonly appId: string | null;
  readonly loginConfigId: string | null;
  readonly appSecret: string | null;
  readonly verifyToken: string | null;
}

/** Os nomes das variáveis, para a tela dizer exatamente o que falta. */
export const VARIAVEIS_DO_APP_SOCIAL_DA_META = [
  "META_SOCIAL_APP_ID",
  "META_SOCIAL_LOGIN_CONFIG_ID",
  "META_SOCIAL_APP_SECRET",
  "META_SOCIAL_VERIFY_TOKEN",
] as const;

function texto(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** O que o AMBIENTE traz — puro e síncrono. Vazio é ausente (contrato do `.env` do projeto). */
export function appSocialDoAmbiente(
  source: Record<string, string | undefined> = process.env,
): AppSocialDaMetaEmVigor {
  return {
    appId: texto(source.META_SOCIAL_APP_ID) || null,
    loginConfigId: texto(source.META_SOCIAL_LOGIN_CONFIG_ID) || null,
    appSecret: texto(source.META_SOCIAL_APP_SECRET) || null,
    verifyToken: texto(source.META_SOCIAL_VERIFY_TOKEN) || null,
  };
}

const TTL_MS = 30_000;

declare global {
  // Mora no `globalThis` porque o Turbopack instancia o módulo duas vezes no
  // mesmo processo (entrada de rota e de página): um `let` daria dois memos que
  // não se invalidam.
  var __memoDoAppSocialDaMeta: { readonly valor: AppSocialDaMetaEmVigor; readonly expiraEm: number } | null | undefined;
  var __geracaoDoAppSocialDaMeta: number | undefined;
}

/** Chamada por quem ESCREVE a credencial. A geração sobe antes de zerar o memo. */
export function invalidarAppSocialDaMeta(): void {
  globalThis.__geracaoDoAppSocialDaMeta = (globalThis.__geracaoDoAppSocialDaMeta ?? 0) + 1;
  globalThis.__memoDoAppSocialDaMeta = null;
}

interface LinhaDoApp {
  app_id: string | null;
  login_config_id: string | null;
  app_secret_encrypted: string | null;
  verify_token_encrypted: string | null;
}

async function linhaDoBanco(): Promise<LinhaDoApp | null> {
  try {
    const { data, error } = await createAdminClient()
      .from("platform_meta_social_app")
      .select("app_id, login_config_id, app_secret_encrypted, verify_token_encrypted")
      .eq("id", 1)
      // Fora da deduplicação de `fetch` do Next dentro de um render (#1218): sem o
      // `signal`, uma 2ª leitura do mesmo render receberia a resposta de ANTES de
      // uma escrita. Nunca é abortado.
      .abortSignal(new AbortController().signal)
      .maybeSingle();
    if (error) {
      logger.info("[meta-social.app] sem credencial no banco; vale o .env", { codigo: error.code });
      return null;
    }
    return (data as LinhaDoApp | null) ?? null;
  } catch (err) {
    logger.warn("[meta-social.app] leitura do banco falhou; vale o .env", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** O par de segredos do banco, ou `null` quando só METADE serve (meia credencial = nenhuma). */
async function segredosDoBanco(
  linha: LinhaDoApp | null,
): Promise<{ appSecret: string; verifyToken: string } | null> {
  const segredoCifrado = texto(linha?.app_secret_encrypted);
  const tokenCifrado = texto(linha?.verify_token_encrypted);
  if (!segredoCifrado || !tokenCifrado) return null;

  const admin = createAdminClient();
  const appSecret = texto(await decryptWebhookSecret(admin, segredoCifrado));
  const verifyToken = texto(await decryptWebhookSecret(admin, tokenCifrado));
  if (!appSecret || !verifyToken) {
    logger.warn("[meta-social.app] credencial do banco não decifrou; vale o .env inteiro");
    return null;
  }
  return { appSecret, verifyToken };
}

/** A configuração em vigor — banco primeiro, `.env` como piso. Nunca lança. */
export async function appSocialDaMeta(): Promise<AppSocialDaMetaEmVigor> {
  const memo = globalThis.__memoDoAppSocialDaMeta;
  if (memo && memo.expiraEm > Date.now()) return memo.valor;

  // Geração lida ANTES do banco e conferida depois: uma leitura que entrou em voo
  // antes de `invalidarAppSocialDaMeta()` não pode reinstalar o valor pré-escrita.
  const geracao = globalThis.__geracaoDoAppSocialDaMeta ?? 0;
  const linha = await linhaDoBanco();
  const ambiente = appSocialDoAmbiente();
  const segredos = await segredosDoBanco(linha);

  const valor: AppSocialDaMetaEmVigor = {
    appId: texto(linha?.app_id) || ambiente.appId,
    loginConfigId: texto(linha?.login_config_id) || ambiente.loginConfigId,
    appSecret: segredos ? segredos.appSecret : ambiente.appSecret,
    verifyToken: segredos ? segredos.verifyToken : ambiente.verifyToken,
  };

  if ((globalThis.__geracaoDoAppSocialDaMeta ?? 0) === geracao) {
    globalThis.__memoDoAppSocialDaMeta = { valor, expiraEm: Date.now() + TTL_MS };
  }
  return valor;
}
