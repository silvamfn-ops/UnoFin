# UnoFin v2.4 — Gestão Orçamental Individual (PWA para iPhone)

Aplicação web progressiva (PWA) focada na gestão financeira pessoal de um único utilizador, reunindo a simplicidade de utilização individual com as melhores valências funcionais do DuoFin 2 (100% local e offline no iPhone).

## Novidades da versão 2.4
- **Fixos do Ciclo (Lançamento em 1 Toque):** Lista colapsável de despesas fixas mensais (renda, energia, telecomunicações, ginásio) com deteção automática de pagamento no ciclo e lançamento instantâneo.
- **Cartão de Crédito Opcional ("Sem Atrito"):** Mantém *Conta à Ordem* selecionada por defeito, mas permite marcar despesas a *Crédito* para acumular num indicador separado e liquidar tudo num toque após o dia de vencimento.
- **Resumo do Ciclo Partilhável:** Botão na aba *Análise* para copiar ou partilhar o balanço fechado do ciclo pelo iOS Share Sheet.
- **Gestão de Regras Memorizadas:** Consulta e limpeza das associações automáticas aprendidas durante as importações de PDF.

## Funcionalidades Base (v2.3)
- Importação de extratos bancários em PDF com aprendizagem automática de categorias e deteção de duplicados (±3 dias).
- Acerto rápido de saldo real (reconciliação com o banco).
- Armazenamento robusto em `IndexedDB` com exportação/importação de backup `.json`.

## Como instalar no iPhone (via GitHub Pages)
1. Carrega todos os ficheiros desta pasta para o teu repositório GitHub (`unofin`).
2. Aguarda a publicação no GitHub Pages e abre a app no iPhone.
3. Fecha completamente a app no seletor de tarefas do iOS e volta a abrir para ativar a versão `v2.4.0`.
