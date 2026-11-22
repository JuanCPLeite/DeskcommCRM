/**
 * A configuração PÚBLICA do Embedded Signup desta instalação: `app_id` e os dois
 * `config_id` (número novo / coexistência), mais o padrão de liberação.
 *
 * ─── Por que isto NÃO está em `app.ts` ──────────────────────────────────────
 *
 * `app.ts` serve o PAR de segredo (App Secret + verify token) a CADA entrega de
 * webhook, e a regra dele é "o par vem inteiro de uma fonte só". Estes três valores
 * são outra coisa: identificadores públicos que vão ao navegador por desenho (a
 * Meta os exige no `FB.init`/`FB.login`), lidos só quando alguém abre a tela de
 * conexão. Misturá-los ao resolvedor do webhook acoplaria a hot path de entrega à
 * existência de colunas novas — e um banco anterior à 9452 passaria a degradar o
 * webhook por causa de um EXTRA.
 *
 * ─── Nunca lança, e nunca devolve segredo ───────────────────────────────────
 *
 * Banco sem a 9452 (clone que não atualizou) responde 42703/PGRST204 e a leitura
 * cai para `META_APP_ID` do `.env` — o mesmo piso de rollback do restante do canal.
 * Sem `config_id` o Embedded Signup simplesmente não é oferecido: a janela da Meta
 * não abre sem ele, e a tela diz o que falta.
 */
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export interface SignupDaMeta {
  /** ID público do app da Meta. Nulo = não configurado. */
  readonly appId: string | null;
  /** `config_id` para conectar um número NOVO. */
  readonly configId: string | null;
  /** `config_id` para a coexistência com o app WhatsApp Business. Nulo = não oferecida. */
  readonly configIdCoexistencia: string | null;
  /** Empresa sem linha em `organization_meta_access` herda isto. */
  readonly liberadoPorPadrao: boolean;
}

export const SIGNUP_VAZIO: SignupDaMeta = {
  appId: null,
  configId: null,
  configIdCoexistencia: null,
  liberadoPorPadrao: false,
};

/** Os ids da Meta são numéricos. Qualquer outra coisa é erro de cópia, não config. */
const FORMATO_DE_ID = /^[0-9]{5,30}$/;

export function idDaMetaValido(valor: unknown): valor is string {
  return typeof valor === "string" && FORMATO_DE_ID.test(valor.trim());
}

function idOuNulo(valor: unknown): string | null {
  return idDaMetaValido(valor) ? valor.trim() : null;
}

/** O que o AMBIENTE traz — puro. Só o `app_id`; os `config_id` nascem pela tela. */
export function signupDoAmbiente(
  source: Record<string, string | undefined> = process.env,
): SignupDaMeta {
  return { ...SIGNUP_VAZIO, appId: idOuNulo(source.META_APP_ID) };
}

interface LinhaDoSignup {
  app_id?: string | null;
  signup_config_id?: string | null;
  signup_config_id_coexistencia?: string | null;
  signup_liberado_por_padrao?: boolean | null;
}

/** Puro: a linha do banco, normalizada, com o `.env` como piso do `app_id`. */
export function signupDaLinha(
  linha: LinhaDoSignup | null,
  ambiente: SignupDaMeta = signupDoAmbiente(),
): SignupDaMeta {
  if (!linha) return ambiente;
  return {
    appId: idOuNulo(linha.app_id) ?? ambiente.appId,
    configId: idOuNulo(linha.signup_config_id),
    configIdCoexistencia: idOuNulo(linha.signup_config_id_coexistencia),
    liberadoPorPadrao: linha.signup_liberado_por_padrao === true,
  };
}

export const COLUNAS_DO_SIGNUP =
  "app_id, signup_config_id, signup_config_id_coexistencia, signup_liberado_por_padrao";

/** Banco anterior à 9452: o PostgREST recusa pela coluna, e isso NÃO é erro do operador. */
export function ehColunaDoSignupAusente(codigo: string | undefined): boolean {
  return codigo === "42703" || codigo === "PGRST204" || codigo === "PGRST200";
}

export async function signupDaMeta(): Promise<SignupDaMeta> {
  try {
    const { data, error } = await createAdminClient()
      .from("platform_meta_app")
      .select(COLUNAS_DO_SIGNUP)
      .eq("id", 1)
      .maybeSingle();
    if (error) {
      if (!ehColunaDoSignupAusente((error as { code?: string }).code)) {
        logger.warn("[meta.signup] leitura da configuração falhou; vale o .env", {
          codigo: (error as { code?: string }).code ?? null,
        });
      }
      return signupDoAmbiente();
    }
    return signupDaLinha(data as LinhaDoSignup | null);
  } catch (err) {
    logger.warn("[meta.signup] leitura da configuração falhou; vale o .env", {
      error: err instanceof Error ? err.message : String(err),
    });
    return signupDoAmbiente();
  }
}
