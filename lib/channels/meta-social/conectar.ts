/**
 * Conectar contas Instagram ao CRM pelo login unificado da Meta (app da instalação).
 *
 * Duas pernas, as duas só no servidor:
 *   iniciarConexaoMeta  → a URL do diálogo de consentimento, com o estado assinado;
 *   concluirConexaoMeta → a volta: confere o estado, troca o código pelo token,
 *                         lista as contas que o login trouxe, e para cada uma
 *                         cria (ou renova) o canal e assina o webhook.
 *
 * REGRA DO TENANT: uma conta ativa pertence a UMA organização. O webhook da Meta
 * resolve a organização por `social_account_id`; a mesma conta em duas
 * organizações misturaria as caixas de entrada. A segunda é recusada, e a sessão
 * da primeira nunca é tocada.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

import { appSocialDaMeta } from "./app";
import { SemContaAtribuidaError, assinarWebhooks, contasAtribuidas, expiracaoDoToken, perfilDaConta } from "./graph";
import { paraEstadoDaMeta, trocarCodigo, urlDeAutorizacao, verificarEstadoDaMeta } from "./oauth";
import { atualizarSessao, criarSessao, sessaoAtivaDaConta } from "./store";

export type CodigoDoErroDaConexao =
  | "app_nao_configurado"
  | "estado_invalido"
  | "estado_de_outra_sessao"
  | "sem_conta_atribuida"
  | "troca_do_codigo_falhou"
  | "cifra_indisponivel";

export class ErroDaConexaoMeta extends Error {
  constructor(
    public readonly codigo: CodigoDoErroDaConexao,
    mensagem: string,
    public readonly faltam: string[] = [],
  ) {
    super(mensagem);
    this.name = "ErroDaConexaoMeta";
  }
}

export interface ContextoDaConexaoMeta {
  organizationId: string;
  userId: string;
  /** `env.INTERNAL_SECRET`, injetado (o estado não pode depender de uma chave por processo). */
  segredo: string;
  agora: Date;
  /** A base pública da instalação, sem barra final. */
  publicBase: string;
}

/** O endereço que a Meta chama na volta: uma ponte pública, porque o cookie de sessão não viaja. */
export function redirectUriDaMeta(publicBase: string): string {
  return `${publicBase.replace(/\/+$/, "")}/auth/meta-social-return`;
}

async function appCompleto() {
  const app = await appSocialDaMeta();
  const faltam = (["appId", "loginConfigId", "appSecret"] as const).filter((c) => !app[c]);
  if (faltam.length > 0) {
    throw new ErroDaConexaoMeta("app_nao_configurado", "O app Meta desta instalação não está configurado.", [...faltam]);
  }
  return { appId: app.appId as string, loginConfigId: app.loginConfigId as string, appSecret: app.appSecret as string };
}

export async function iniciarConexaoMeta(ctx: ContextoDaConexaoMeta): Promise<{ url: string }> {
  const app = await appCompleto();
  const state = paraEstadoDaMeta(
    { organizationId: ctx.organizationId, userId: ctx.userId },
    { segredo: ctx.segredo, agora: ctx.agora },
  );
  return {
    url: urlDeAutorizacao({
      appId: app.appId,
      loginConfigId: app.loginConfigId,
      redirectUri: redirectUriDaMeta(ctx.publicBase),
      state,
    }),
  };
}

export interface ContaConectada {
  channelId: string;
  igId: string;
  username: string;
  webhookAssinado: boolean;
}

export interface ResultadoDaConexao {
  conectadas: ContaConectada[];
  recusadas: { igId: string; motivo: "ja_conectada_em_outra_organizacao" }[];
}

export async function concluirConexaoMeta(
  db: SupabaseClient,
  ctx: ContextoDaConexaoMeta,
  volta: { estado: string; code: string },
): Promise<ResultadoDaConexao> {
  const estado = verificarEstadoDaMeta(volta.estado, { segredo: ctx.segredo, agora: ctx.agora });
  if (!estado) throw new ErroDaConexaoMeta("estado_invalido", "O pedido de conexão expirou ou não é válido. Comece de novo.");
  // O estado foi emitido para uma organização e uma pessoa: quem conclui tem de ser a mesma sessão.
  if (estado.organizationId !== ctx.organizationId || estado.userId !== ctx.userId) {
    throw new ErroDaConexaoMeta("estado_de_outra_sessao", "Este pedido de conexão foi iniciado por outra sessão.");
  }

  const app = await appCompleto();

  let token: string;
  try {
    ({ accessToken: token } = await trocarCodigo({
      appId: app.appId,
      appSecret: app.appSecret,
      redirectUri: redirectUriDaMeta(ctx.publicBase),
      code: volta.code,
    }));
  } catch (err) {
    throw new ErroDaConexaoMeta(
      "troca_do_codigo_falhou",
      err instanceof Error ? err.message : "A Meta recusou o código de autorização.",
    );
  }

  let contas: { id: string; username?: string }[];
  try {
    contas = await contasAtribuidas(token);
  } catch (err) {
    if (err instanceof SemContaAtribuidaError) {
      throw new ErroDaConexaoMeta(
        "sem_conta_atribuida",
        "O login não trouxe nenhuma conta do Instagram. Marque a conta na tela de permissões da Meta.",
      );
    }
    throw err;
  }

  const tokenCifrado = await encryptWebhookSecret(db, token);
  if (!tokenCifrado) throw new ErroDaConexaoMeta("cifra_indisponivel", "A cifra desta instalação não está disponível.");
  const tokenExpiraEm = await expiracaoDoToken({ token, appId: app.appId, appSecret: app.appSecret });

  const resultado: ResultadoDaConexao = { conectadas: [], recusadas: [] };
  for (const conta of contas) {
    const existente = await sessaoAtivaDaConta(db, conta.id);
    if (existente && existente.organizationId !== ctx.organizationId) {
      resultado.recusadas.push({ igId: conta.id, motivo: "ja_conectada_em_outra_organizacao" });
      continue;
    }
    const perfil = await perfilDaConta(token, conta.id);
    const webhookAssinado = await assinarWebhooks(token, conta.id);
    let channelId: string;
    if (existente) {
      await atualizarSessao(db, {
        organizationId: ctx.organizationId,
        sessionId: existente.id,
        tokenCifrado,
        tokenExpiraEm,
        webhookAssinado,
      });
      channelId = existente.id;
    } else {
      ({ id: channelId } = await criarSessao(db, {
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        socialAccountId: conta.id,
        username: perfil.username || conta.username || "",
        tokenCifrado,
        tokenExpiraEm,
        webhookAssinado,
      }));
    }
    resultado.conectadas.push({ channelId, igId: conta.id, username: perfil.username, webhookAssinado });
  }
  return resultado;
}
