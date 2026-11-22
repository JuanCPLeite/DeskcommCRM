/**
 * O que a EMPRESA pode fazer no canal oficial: abrir o Embedded Signup, usar a
 * coexistência e quantos números pode ter.
 *
 * ─── Falha FECHADO ──────────────────────────────────────────────────────────
 *
 * Este é um portão de recurso que abre a conexão de números de terceiros. Qualquer
 * dúvida — banco fora, linha ilegível, banco anterior à 9452 — devolve "bloqueado".
 * O oposto (falhar aberto) deixaria um erro de leitura liberar o recurso a todo
 * cliente da instalação sem ninguém ter decidido.
 *
 * ─── Herança em três estados ────────────────────────────────────────────────
 *
 * Em `organization_meta_access`, cada campo é `true` (libera), `false` (bloqueia)
 * ou nulo (herda `platform_meta_app.signup_liberado_por_padrao`). Linha ausente é o
 * mesmo que tudo nulo. Diferente de `organization_modules` (9416), a instalação NÃO
 * é teto aqui: quem revende precisa de "desligado para a maioria, ligado para quem
 * contratou", e o teto impediria exatamente isso.
 *
 * ─── O teto de números soma com o limite do plano ───────────────────────────
 *
 * `maxNumeros` NÃO substitui `trg_trava_canais_do_plano`: o menor dos dois manda,
 * e quem aplica o do plano continua sendo o gatilho do banco. Este arquivo só
 * aplica o da empresa, ANTES de a pessoa ser mandada à janela da Meta — conferir
 * só na gravação terminaria o cadastro e recusaria no fim.
 */
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { SIGNUP_VAZIO, signupDaMeta } from "./signup-config";

export interface AcessoDaEmpresa {
  readonly embeddedSignup: boolean;
  /** Só vale com `embeddedSignup` — coexistência é um modo DO Embedded Signup. */
  readonly coexistencia: boolean;
  /** Teto da empresa; nulo = só o plano. */
  readonly maxNumeros: number | null;
}

/** Fechado: o estado de quem não foi liberado, ou de quem não se pôde conferir. */
export const ACESSO_FECHADO: AcessoDaEmpresa = {
  embeddedSignup: false,
  coexistencia: false,
  maxNumeros: null,
};

export interface LinhaDeAcesso {
  embedded_signup?: boolean | null;
  coexistencia?: boolean | null;
  max_numeros?: number | null;
}

function tresEstados(valor: boolean | null | undefined, padrao: boolean): boolean {
  if (valor === true) return true;
  if (valor === false) return false;
  return padrao;
}

/** Puro: resolve a linha da empresa contra o padrão da instalação. */
export function resolverAcesso(
  linha: LinhaDeAcesso | null,
  liberadoPorPadrao: boolean,
): AcessoDaEmpresa {
  const embeddedSignup = tresEstados(linha?.embedded_signup, liberadoPorPadrao);
  const coexistencia = embeddedSignup && tresEstados(linha?.coexistencia, liberadoPorPadrao);
  const max = linha?.max_numeros;
  const maxNumeros = typeof max === "number" && Number.isInteger(max) && max >= 0 ? max : null;
  return { embeddedSignup, coexistencia, maxNumeros };
}

/**
 * Pode esta empresa conectar MAIS UM número agora, dado quantos já tem ativos?
 *
 * `maxNumeros === 0` é "nenhum", e é diferente de nulo ("sem teto da empresa").
 */
export function cabeMaisUmNumero(acesso: AcessoDaEmpresa, ativos: number): boolean {
  if (acesso.maxNumeros === null) return true;
  return ativos < acesso.maxNumeros;
}

export const MENSAGEM_DO_TETO_DA_EMPRESA =
  "O limite de números oficiais desta empresa foi atingido. Peça a quem administra a instalação para ampliar o limite.";

/** Nunca lança; falha fechada. */
export async function acessoDaEmpresa(organizationId: string): Promise<AcessoDaEmpresa> {
  if (!organizationId) return ACESSO_FECHADO;
  try {
    const padrao = (await signupDaMeta()).liberadoPorPadrao ?? SIGNUP_VAZIO.liberadoPorPadrao;
    const { data, error } = await createAdminClient()
      .from("organization_meta_access")
      .select("embedded_signup, coexistencia, max_numeros")
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (error) {
      // Tabela ausente (banco anterior à 9452) = ninguém foi liberado: fechado.
      const codigo = (error as { code?: string }).code;
      if (codigo !== "42P01" && codigo !== "PGRST205") {
        logger.warn("[meta.acesso] leitura do acesso da empresa falhou; bloqueado", { codigo: codigo ?? null });
      }
      return ACESSO_FECHADO;
    }
    return resolverAcesso(data as LinhaDeAcesso | null, padrao);
  } catch (err) {
    logger.warn("[meta.acesso] leitura do acesso da empresa falhou; bloqueado", {
      error: err instanceof Error ? err.message : String(err),
    });
    return ACESSO_FECHADO;
  }
}
