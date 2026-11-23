---
impacto: capacidade_nova
secao: adicionado
titulo: A lista de modelos da API oficial se atualiza sozinha: o que for criado, editado ou apagado na Meta aparece sem clicar em Sincronizar
---

Antes, um modelo criado, editado ou apagado direto no painel da Meta (ou por outro
sistema da mesma conta) só aparecia certo em Conexões › Modelos depois de alguém clicar
em Sincronizar.

Agora o CRM refaz a lista da conta sozinho:

- **Em segundos**, quando a Meta avisa por webhook (status, categoria, qualidade ou
  conteúdo do modelo). O CRM passa a pedir também o campo `message_template_components_update`.
- **De 10 em 10 minutos**, pelo agendador, como rede de segurança para o aviso que a Meta não
  entregou. O cron novo é `modelos-oficiais-sync`; ele respeita organização suspensa.

O modelo apagado na Meta continua marcado como desativado em vez de sumir, porque
lembretes da agenda e avisos de caso podem apontar para ele.

**Ação do operador:** o agendador ganhou uma linha, então a imagem do `scheduler` precisa
ser atualizada junto com a do app. Na instalação padrão, o `update.sh` já faz isso.

**Avisos mesmo sem webhook.** A mesma rodada de 10 em 10 minutos compara o que a Meta
responde com a última resposta e abre na Central o aviso que o webhook abriria: modelo que
mudou de categoria (utilidade ↔ marketing), de qualidade ou de status (reprovado, pausado,
desativado), e número cuja qualidade ou limite de envio mudou. O aviso não repete se o
webhook já o abriu. Na primeira consulta de um número o CRM só registra o estado, sem
abrir aviso. O botão Sincronizar também passa a abrir esses avisos.
