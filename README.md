# UnoFin — Gestão Orçamental Individual (PWA para iPhone)

Aplicação web progressiva (PWA) focada na gestão financeira pessoal de um único utilizador, com funcionamento 100% local e offline no iPhone.

## Estrutura do Projeto
- `index.html` — Interface completa, lógica de ciclos orçamentais, gráficos SVG e gestão de armazenamento local (`localStorage`).
- `manifest.json` — Configuração PWA para instalação no ecrã principal do iOS.
- `sw.js` — *Service Worker* para cache offline.
- `icon.svg` — Ícone vetorial da aplicação.

## Como instalar no iPhone (via GitHub Pages)
1. Cria um repositório no GitHub (ex.: `unofin`) e carrega todos os ficheiros desta pasta.
2. Vai a **Settings > Pages**, seleciona a branch `main` e guarda.
3. Abre o endereço gerado no **Safari** do iPhone.
4. Toca no ícone de **Partilhar** (quadrado com seta para cima) e seleciona **"Adicionar ao ecrã principal"**.
