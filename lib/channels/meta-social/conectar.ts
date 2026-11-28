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

import { lerLimiteEstourado } from "@/lib/cobranca/limites";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

import { appSocialDaMeta } from "./app";
import { SemContaAtribuidaError, assinarWebhooks, contasAtribuidas, expiracaoDoToken, perfilDaConta } from "./graph";
import {
  modoDaConfiguracao,
  perfilDoInstagram,
  trocarCodigoDoInstagram,
  urlDeAutorizacaoDoInstagram,
  baseDaGraph,
  type ModoDoLogin,
} from "./instagram-login";
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
  const modo = modoDaConfiguracao(app);
  // No login do Instagram não há configuração de login: só o ID do app e a chave.
  const obrigatorios = modo === "instagram" ? (["appId", "appSecret"] as const) : (["appId", "loginConfigId", "appSecret"] as const);
  const faltam = obrigatorios.filter((c) => !app[c]);
  if (faltam.length > 0) {
    throw new ErroDaConexaoMeta("app_nao_configurado", "O app Meta desta instalação não está configurado.", [...faltam]);
  }
  return {
    modo,
    appId: app.appId as string,
    loginConfigId: app.loginConfigId ?? "",
    appSecret: app.appSecret as string,
  };
}

export async function iniciarConexaoMeta(ctx: ContextoDaConexaoMeta): Promise<{ url: string }> {
  const app = await appCompleto();
  const state = paraEstadoDaMeta(
    { organizationId: ctx.organizationId, userId: ctx.userId },
    { segredo: ctx.segredo, agora: ctx.agora },
  );
  if (app.modo === "instagram") {
    return { url: urlDeAutorizacaoDoInstagram({ appId: app.appId, redirectUri: redirectUriDaMeta(ctx.publicBase), state }) };
  }
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
  recusadas: { igId: string; motivo: "ja_conectada_em_outra_organizacao" | "falhou" }[];
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

  const modo: ModoDoLogin = app.modo;
  let token: string;
  let contas: { id: string; username?: string }[];
  let tokenExpiraEm: Date | null;
  try {
    if (modo === "instagram") {
      const t = await trocarCodigoDoInstagram({
        appId: app.appId,
        appSecret: app.appSecret,
        redirectUri: redirectUriDaMeta(ctx.publicBase),
        code: volta.code,
      });
      token = t.accessToken;
      tokenExpiraEm = t.expiraEm;
      // O login do Instagram autoriza UMA conta: o perfil dela é a lista.
      const perfil = await perfilDoInstagram(token);
      contas = [{ id: perfil.id, username: perfil.username }];
    } else {
      ({ accessToken: token } = await trocarCodigo({
        appId: app.appId,
        appSecret: app.appSecret,
        redirectUri: redirectUriDaMeta(ctx.publicBase),
        code: volta.code,
      }));
      contas = await contasAtribuidas(token);
      tokenExpiraEm = await expiracaoDoToken({ token, appId: app.appId, appSecret: app.appSecret });
    }
  } catch (err) {
    if (err instanceof SemContaAtribuidaError) {
      throw new ErroDaConexaoMeta(
        "sem_conta_atribuida",
        "O login não trouxe nenhuma conta do Instagram. Marque a conta na tela de permissões da Meta.",
      );
    }
    throw new ErroDaConexaoMeta(
      "troca_do_codigo_falhou",
      err instanceof Error ? err.message : "A Meta recusou o código de autorização.",
    );
  }

  const tokenCifrado = await encryptWebhookSecret(db, token);
  if (!tokenCifrado) throw new ErroDaConexaoMeta("cifra_indisponivel", "A cifra desta instalação não está disponível.");
  const base = baseDaGraph(modo);

  const resultado: ResultadoDaConexao = { conectadas: [], recusadas: [] };
  for (const conta of contas) {
    // Cada conta é isolada: a falha de uma NÃO pode deixar as já gravadas sem resposta
    // (e sem auditoria), e a pessoa tentaria de novo com um código que já foi usado.
    try {
      const existente = await sessaoAtivaDaConta(db, conta.id);
      if (existente && existente.organizationId !== ctx.organizationId) {
        resultado.recusadas.push({ igId: conta.id, motivo: "ja_conectada_em_outra_organizacao" });
        continue;
      }
      const perfil = modo === "instagram" ? await perfilDoInstagram(token) : await perfilDaConta(token, conta.id, base);
      const webhookAssinado = await assinarWebhooks(token, conta.id, base);
      let channelId: string;
      if (existente) {
        await atualizarSessao(db, {
          organizationId: ctx.organizationId,
          sessionId: existente.id,
          tokenCifrado,
          tokenExpiraEm,
          webhookAssinado,
          loginModo: modo,
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
          loginModo: modo,
        }));
      }
      resultado.conectadas.push({ channelId, igId: conta.id, username: perfil.username, webhookAssinado });
    } catch (err) {
      // O limite de canais do plano sobe cru: a rota diz o número ao operador.
      if (lerLimiteEstourado(err)) throw err;
      // Outra organização gravou a mesma conta no meio do caminho (o índice único segurou).
      resultado.recusadas.push({
        igId: conta.id,
        motivo: err instanceof Error && err.message === "conta_ja_conectada" ? "ja_conectada_em_outra_organizacao" : "falhou",
      });
    }
  }
  return resultado;
}
