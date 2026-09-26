# SAPilot

Use SAP AI Core models in VS Code Chat.

## Get started

1. Install the extension and open **SAPilot** from the Activity Bar.
2. Enter your service key values and select **Save and connect**.
3. Open VS Code Chat and choose a model under **SAP AI Core**.

SAPilot discovers running chat deployments and selects the right API format for each model. It supports OpenAI-compatible Chat Completions, Claude, Bedrock Converse, Cohere Chat, and Gemini on Vertex AI. Non-chat deployments such as embeddings are not shown.

Your client secret is stored in VS Code SecretStorage. Chat prompts and context are sent to the SAP AI Core model you select. The extension requires VS Code 1.104 or later and a service key with access to a running chat deployment.

Each user should enter their own service key. Do not package a shared key with the extension.
