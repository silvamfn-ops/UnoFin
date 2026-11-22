# UnoFin v2.3 — Gestão Orçamental Individual (PWA para iPhone)

Aplicação web progressiva (PWA) focada na gestão financeira pessoal de um único utilizador, com funcionamento 100% local e offline no iPhone.

## Novidades da versão 2.3
- **Importação de Extratos PDF com Aprendizagem:** Lê extratos bancários em PDF localmente no navegador e memoriza automaticamente as categorias corrigidas pelo utilizador.
- **Deteção de Duplicados (±3 Dias):** Identifica movimentos com o mesmo montante num intervalo de até 3 dias antes ou depois de registos existentes.
- **Acerto Rápido de Saldo (Reconciliação):** Permite alinhar o saldo do ciclo atual com o saldo real do banco num toque.
- **Armazenamento IndexedDB:** Maior capacidade e proteção contra limpezas de cache no iOS, com migração automática a partir do `localStorage`.

## Estrutura do Projeto
- `index.html` — Interface completa, lógica de ciclos orçamentais, importação PDF e armazenamento local (`IndexedDB`).
- `manifest.json` — Configuração PWA para instalação no ecrã principal do iOS.
- `sw.js` — *Service Worker* para cache offline (`unofin-v2.3.0`).
- `icon.svg` — Ícone vetorial da aplicação.

## Como instalar no iPhone (via GitHub Pages)
1. Cria um repositório no GitHub (ex.: `unofin`) e carrega todos os ficheiros desta pasta.
2. Vai a **Settings > Pages**, seleciona a branch `main` e guarda.
3. Abre o endereço gerado no **Safari** do iPhone.
4. Toca no ícone de **Partilhar** (quadrado com seta para cima) e seleciona **"Adicionar ao ecrã principal"**.
