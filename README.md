# SAPilot

Use SAP AI Core models in GitHub Copilot Chat.

## Get started

1. Install the extension. SAPilot opens a short setup guide the first time it runs.
2. Select **Connect to SAP AI Core** and enter your service key values.
3. Open Copilot Chat and choose a running model under **SAP AI Core**.

Click **SAPilot** in the bottom status bar to reopen setup. You can also use the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`) and run **SAPilot: Connect to SAP AI Core**.

SAPilot discovers running chat deployments and selects the right API format for each model. It supports OpenAI-compatible Chat Completions, Claude, Bedrock Converse, Cohere Chat, and Gemini on Vertex AI. Non-chat deployments such as embeddings are not shown.

Your client secret is stored in VS Code SecretStorage. Chat prompts and context are sent to the SAP AI Core model you select. The extension requires VS Code 1.104 or later and a service key with access to a running chat deployment.

Each user should enter their own service key. Do not package a shared key with the extension.
