"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";

export type ModoDoSignup = "numero_novo" | "coexistencia";

export interface ModoDisponivel {
  disponivel: boolean;
  configId: string | null;
  /** O `extras` do `FB.login` para este modo — montado e testado no servidor. */
  extras: Record<string, unknown>;
}

/**
 * O que o navegador precisa para abrir a janela da Meta. Tudo aqui é PÚBLICO por
 * desenho (a Meta exige `app_id` e `config_id` no navegador); o App Secret nunca
 * passa por esta resposta.
 */
export interface EmbeddedSignupConfig {
  disponivel: boolean;
  /** `meta_app_nao_configurado` | `signup_nao_liberado` | null */
  motivo: "meta_app_nao_configurado" | "signup_nao_liberado" | null;
  appId: string | null;
  graphVersion: string;
  modos: Record<ModoDoSignup, ModoDisponivel>;
  numeros: { ativos: number | null; maxNumeros: number | null };
}

export interface FinalizarInput {
  code: string;
  waba_id?: string | null;
  phone_number_id?: string | null;
  modo: ModoDoSignup;
}

export interface DesfechoPassoOpcional {
  registrado?: boolean;
  erro: string | null;
}

export interface ConexaoPeloSignup {
  connected: boolean;
  channelSessionId: string;
  displayName: string;
  phoneNumber: string | null;
  modo: ModoDoSignup;
  webhookRegistro: { registrado: boolean; erro: string | null } | null;
  /** Só em número novo: `registrado: false` = o número não está na Cloud API. */
  registro: { registrado: boolean; erro: string | null } | null;
  /** Só em coexistência. */
  sincronizacao: {
    contatos: { pedido: boolean; erro: string | null };
    historico: { pedido: boolean; erro: string | null };
  } | null;
}

export function useEmbeddedSignupConfig() {
  return useQuery({
    queryKey: ["official-embedded-signup"],
    queryFn: async () =>
      apiClient.get<{ data: EmbeddedSignupConfig }>("/api/v1/channels/official/embedded-signup"),
    staleTime: 15_000,
  });
}

export function useFinalizarEmbeddedSignup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: FinalizarInput) =>
      apiClient.post<{ data: ConexaoPeloSignup }>("/api/v1/channels/official/embedded-signup", input),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["official-channel"] });
      qc.invalidateQueries({ queryKey: ["official-embedded-signup"] });
    },
  });
}
