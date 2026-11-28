"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

import { ChannelAiAccess } from "./ChannelAiAccess";

interface Conta {
  channel_id: string;
  ig_id: string;
  username: string;
  health: "ok" | "token_vencido" | "atencao";
  webhook_assinado: boolean;
}

interface Listagem {
  data: { configured: boolean; faltam: string[]; configurar_em: string | null; accounts: Conta[] };
}

interface Conclusao {
  data: { conectadas: { username: string }[]; recusadas: { ig_id: string }[] };
}

const CHAVE = ["meta-social-contas"] as const;
const NOME_DA_JANELA = "meta-social-conexao";
/** Canal entre a janela de conexão e a tela que a abriu (mesma origem). Não depende de `window.opener`,
 *  que o login da Meta pode cortar (política de isolamento da janela). */
const CANAL = "meta-social-conexao";
/** Marca de que ESTE navegador abriu a janela de conexão há pouco: é o que a janela confere ao voltar. */
const MARCA_DA_JANELA = "meta-social-janela";
const VALIDADE_DA_MARCA_MS = 30 * 60 * 1000;
type Fim = { resultado?: Conclusao["data"] | null; cancelada?: boolean };

/**
 * Instagram pela conexão DIRETA com a Meta: conectar contas pelo app Meta da
 * instalação (login unificado) e ver a saúde de cada uma. A volta do login chega
 * pela ponte pública `/auth/meta-social-return`, que repassa estado e código na
 * URL desta aba; quem conclui é esta tela, autenticada, uma vez só.
 */
export function MetaSocialClient() {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const [aDesconectar, setADesconectar] = useState<Conta | null>(null);
  const concluiu = useRef(false);
  const [fechavel, setFechavel] = useState(false);

  const lista = useQuery({ queryKey: CHAVE, queryFn: () => apiClient.get<Listagem>("/api/v1/channels/meta-social") });

  // A conexão abre numa JANELA à parte: a tela de Conexões fica onde está e, ao fim, a
  // janela avisa e fecha. A janela é aberta NO CLIQUE (antes de qualquer espera) porque o
  // navegador só a permite em resposta direta a um gesto; se ele a bloquear, cai no
  // caminho antigo e a conexão acontece na mesma aba.
  const janela = useRef<Window | null>(null);
  const conectar = useMutation({
    mutationFn: () => apiClient.post<{ data: { url: string } }>("/api/v1/channels/meta-social", { acao: "iniciar" }),
    onSuccess: (r) => {
      if (janela.current && !janela.current.closed) janela.current.location.href = r.data.url;
      else window.location.assign(r.data.url);
    },
    onError: () => {
      janela.current?.close();
      toast.error(t("Não foi possível concluir a conexão."));
    },
  });
  function abrirConexao() {
    janela.current = window.open("about:blank", NOME_DA_JANELA, "popup=yes,width=620,height=760");
    if (janela.current) localStorage.setItem(MARCA_DA_JANELA, String(Date.now()));
    else localStorage.removeItem(MARCA_DA_JANELA);
    conectar.mutate();
  }

  // A janela terminou: mostra o resultado aqui e atualiza a lista.
  useEffect(() => {
    const canal = new BroadcastChannel(CANAL);
    canal.onmessage = (e: MessageEvent<Fim>) => {
      const d = e.data;
      if (d.cancelada) toast.error(t("A conexão foi cancelada na Meta."));
      else if (!d.resultado) toast.error(t("Não foi possível concluir a conexão."));
      else {
        for (const c of d.resultado.conectadas) toast.success(`${t("Conta conectada")}: @${c.username}`);
        if (d.resultado.recusadas.length > 0) toast.error(t("Esta conta já está conectada em outra empresa e não foi adicionada."));
      }
      void queryClient.invalidateQueries({ queryKey: CHAVE });
    };
    return () => canal.close();
  }, [queryClient, t]);

  const desconectar = useMutation({
    mutationFn: (id: string) => apiClient.delete(`/api/v1/channel-sessions/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: CHAVE }),
    onError: () => toast.error(t("Não foi possível desconectar. Tente novamente.")),
  });

  // A volta da Meta: conclui UMA vez e limpa a URL (o código é de uso único).
  const estado = params.get("ms_estado");
  const codigo = params.get("ms_code");
  const erro = params.get("ms_erro");
  useEffect(() => {
    if (!estado || concluiu.current) return;
    concluiu.current = true;
    const limpar = () => router.replace(pathname + "?aba=meta-social");
    // Dentro da janela de conexão: entrega o resultado à tela que a abriu e fecha.
    const marca = Number(localStorage.getItem(MARCA_DA_JANELA) ?? 0);
    const naJanela = Date.now() - marca < VALIDADE_DA_MARCA_MS;
    function entregar(msg: Fim) {
      localStorage.removeItem(MARCA_DA_JANELA);
      const canal = new BroadcastChannel(CANAL);
      canal.postMessage(msg);
      canal.close();
      window.close();
      // Se o navegador não deixar fechar, a pessoa vê o recado e fecha.
      setFechavel(true);
    }
    if (erro) {
      if (naJanela) return entregar({ cancelada: true });
      toast.error(t("A conexão foi cancelada na Meta."));
      limpar();
      return;
    }
    if (!codigo) {
      if (naJanela) return entregar({ resultado: null });
      limpar();
      return;
    }
    apiClient
      .post<Conclusao>("/api/v1/channels/meta-social", { acao: "concluir", estado, code: codigo })
      .then((r) => {
        if (naJanela) return entregar({ resultado: r.data });
        for (const c of r.data.conectadas) toast.success(`${t("Conta conectada")}: @${c.username}`);
        if (r.data.recusadas.length > 0) toast.error(t("Esta conta já está conectada em outra empresa e não foi adicionada."));
        void queryClient.invalidateQueries({ queryKey: CHAVE });
      })
      .catch(() => {
        if (naJanela) return entregar({ resultado: null });
        toast.error(t("Não foi possível concluir a conexão."));
      })
      .finally(() => {
        if (!naJanela) limpar();
      });
  }, [estado, codigo, erro, pathname, router, queryClient, t]);

  const dados = lista.data?.data;

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3 p-4">
        <div>
          <h2 className="font-medium">{t("Instagram pela Meta")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("Conecte contas do Instagram direto pelo app Meta da instalação. As conversas chegam na Caixa de Entrada.")}
          </p>
        </div>

        {dados && !dados.configured ? (
          <p role="status" className="rounded-md border border-warning/40 bg-warning-bg p-3 text-xs leading-4 text-text-muted">
            {t("O app Meta desta instalação ainda não está configurado.")}{" "}
            {dados.configurar_em ? (
              <Link href={dados.configurar_em} className="font-medium underline underline-offset-2">
                {t("Configurar o app")}
              </Link>
            ) : null}
          </p>
        ) : null}

        <div>
          <Button
            data-testid="meta-social-conectar"
            disabled={!dados?.configured || conectar.isPending}
            onClick={abrirConexao}
          >
            {t("Conectar Instagram")}
          </Button>
        </div>
        {estado && !erro ? (
          <p className="text-xs text-muted-foreground">
            {fechavel ? t("Conexão concluída. Pode fechar esta janela.") : t("Concluindo a conexão com a Meta…")}
          </p>
        ) : null}
      </Card>

      {dados && dados.accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("Nenhuma conta do Instagram conectada ainda.")}</p>
      ) : null}

      {dados?.accounts.map((c) => (
        <Card key={c.channel_id} data-testid="meta-social-conta" className="flex flex-col gap-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col gap-1">
              <span className="font-medium">@{c.username || c.ig_id}</span>
              <div className="flex flex-wrap gap-2">
                {c.health === "ok" ? <Badge variant="neutral">{t("Conectada")}</Badge> : null}
                {c.health === "token_vencido" ? <Badge variant="warning">{t("O acesso venceu. Reconecte.")}</Badge> : null}
                {c.health === "atencao" ? <Badge variant="warning">{t("Precisa de atenção")}</Badge> : null}
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => setADesconectar(c)}>
              {t("Desconectar")}
            </Button>
          </div>
          {!c.webhook_assinado ? (
            <p className="text-xs text-muted-foreground">
              {t("Webhook pendente: as mensagens podem não chegar. Reconecte a conta.")}
            </p>
          ) : null}
          <ChannelAiAccess channelId={c.channel_id} phoneTesting={false} socialTesting={false} />
        </Card>
      ))}

      <AlertDialog open={aDesconectar !== null} onOpenChange={(aberto) => !aberto && setADesconectar(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Desconectar esta conta?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("O CRM deixa de receber e enviar mensagens dessa conta. As conversas já feitas continuam na Caixa de Entrada.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="meta-social-confirmar-desconectar"
              onClick={() => {
                if (aDesconectar) desconectar.mutate(aDesconectar.channel_id);
                setADesconectar(null);
              }}
            >
              {t("Desconectar")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

