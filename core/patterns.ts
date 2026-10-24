/**
 * Apex Redact — patrones de detección de secretos.
 *
 * Fuentes (patrones por defecto copiados íntegramente):
 *  - opencode-secret-redactor@0.5.1  (casonadams)
 *  - opencode-warden@latest          (toreuyar)
 *  - más los patrones propios de apex
 *
 * Cada patrón declara:
 *  - `name`        identificador único (se usa como etiqueta legible del marcador)
 *  - `regex`       expresión regular con flag `g`
 *  - `confidence`  low | medium | high — filtra vía `redact.minConfidence`
 *  - `validate?`   comprobación extra sobre el match (Luhn, IPs privadas…)
 *
 * NOTA IMPORTANTE: apex redacta el CONTEXTO COMPLETO (system prompt + historial
 * + tools), no solo la salida de una tool. Por eso los patrones ruidosos o de
 * baja confianza NO se activan por defecto (`minConfidence: "medium"`), y los
 * de PII viven en bundles propios que hay que activar explícitamente.
 */

export type PatternConfidence = "low" | "medium" | "high"

export interface PatternDefinition {
  readonly name: string
  readonly regex: RegExp
  readonly confidence: PatternConfidence
  /** Comprobación adicional; si devuelve false el match se ignora. */
  readonly validate?: (match: string) => boolean
  /** Origen del patrón, para trazabilidad. */
  readonly source?: "apex" | "secret-redactor" | "warden"
}

// ---------------------------------------------------------------------------
// Validadores compartidos
// ---------------------------------------------------------------------------

/** Algoritmo de Luhn (tarjetas de crédito). */
export function luhnCheck(value: string): boolean {
  const digits = value.replace(/\D/g, "")
  if (digits.length < 12) return false
  let sum = 0
  let alternate = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number.parseInt(digits[i]!, 10)
    if (alternate) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alternate = !alternate
  }
  return sum % 10 === 0
}

const PRIVATE_IP = /^(?:127\.|0\.0\.0\.0|192\.168\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.|255\.255\.255\.)/
const isPublicIp = (value: string): boolean => !PRIVATE_IP.test(value)

// ---------------------------------------------------------------------------
// Bundles
// ---------------------------------------------------------------------------

const BUNDLES: Record<string, PatternDefinition[]> = {
  // ------------------------------------------------------------------ AWS
  aws: [
    { name: "aws-access-key-id", regex: /\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA)[0-9A-Z]{16}\b/g, confidence: "high", source: "warden" },
    {
      name: "aws-secret-access-key",
      regex: /(?<=(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY|SecretAccessKey|secret_access_key)\s*[=:\s"']+)[A-Za-z0-9/+=]{40}/g,
      confidence: "high",
      source: "warden",
    },
  ],

  // --------------------------------------------------------------- GitHub
  github: [
    { name: "github-pat", regex: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g, confidence: "high", source: "warden" },
    { name: "github-fine-grained-pat", regex: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g, confidence: "high", source: "warden" },
    { name: "github-app-token", regex: /\bghu_[A-Za-z0-9]{36,}/g, confidence: "high", source: "secret-redactor" },
    { name: "github-app-install", regex: /\bghs_[A-Za-z0-9]{36,}/g, confidence: "high", source: "secret-redactor" },
  ],

  // --------------------------------------------------------------- GitLab
  gitlab: [
    { name: "gitlab-pat", regex: /\bglpat-[A-Za-z0-9_-]{20,}/g, confidence: "high", source: "secret-redactor" },
    { name: "gitlab-pipeline-trigger", regex: /\bglptt-[A-Za-z0-9_-]{20,}/g, confidence: "high", source: "secret-redactor" },
    { name: "gitlab-deploy-token", regex: /\bgldt-[A-Za-z0-9_-]{20,}/g, confidence: "high", source: "secret-redactor" },
    { name: "gitlab-ci-job-token", regex: /\bglcbt-[A-Za-z0-9_-]{20,}/g, confidence: "high", source: "secret-redactor" },
    { name: "gitlab-runner-token", regex: /\bglrt-[A-Za-z0-9_-]{20,}/g, confidence: "high", source: "secret-redactor" },
    { name: "gitlab-service-account", regex: /\bglsoat-[A-Za-z0-9_-]{20,}/g, confidence: "high", source: "secret-redactor" },
    { name: "gitlab-feed-token", regex: /\bglft-[A-Za-z0-9_-]{20,}/g, confidence: "high", source: "secret-redactor" },
    { name: "gitlab-incoming-mail", regex: /\bglimt-[A-Za-z0-9_-]{20,}/g, confidence: "high", source: "secret-redactor" },
    { name: "gitlab-oauth-secret", regex: /\bgloas-[A-Za-z0-9_-]{20,}/g, confidence: "high", source: "secret-redactor" },
    { name: "gitlab-agent-token", regex: /\bglagent-[A-Za-z0-9_-]{20,}/g, confidence: "high", source: "secret-redactor" },
  ],

  // -------------------------------------------------------- Proveedores IA
  openai: [
    { name: "openai-project-key", regex: /\bsk-proj-[A-Za-z0-9_-]{20,}/g, confidence: "high", source: "warden" },
    { name: "openai-legacy-key", regex: /\bsk-(?!ant-)(?!proj-)[A-Za-z0-9]{20,}/g, confidence: "medium", source: "secret-redactor" },
  ],
  anthropic: [
    { name: "anthropic-api-key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, confidence: "high", source: "warden" },
  ],
  cohere: [{ name: "cohere-key", regex: /\bco-[A-Za-z0-9]{30,}/g, confidence: "low", source: "secret-redactor" }],
  huggingface: [{ name: "huggingface-token", regex: /\bhf_[A-Za-z0-9]{30,}/g, confidence: "high", source: "secret-redactor" }],

  // ------------------------------------------------------------ Google Cloud
  google: [
    { name: "gcp-api-key", regex: /\bAIza[0-9A-Za-z_-]{35}/g, confidence: "high", source: "warden" },
    { name: "google-oauth-secret", regex: /\bGOCSPX-[A-Za-z0-9_-]{28}/g, confidence: "high", source: "secret-redactor" },
    { name: "gcloud-access-token", regex: /\bya29\.[A-Za-z0-9_-]{50,}/g, confidence: "high", source: "secret-redactor" },
    { name: "google-refresh-token", regex: /\b1\/\/[A-Za-z0-9_-]{40,}/g, confidence: "medium", source: "secret-redactor" },
  ],

  // ------------------------------------------------------------- Plataformas
  slack: [
    { name: "slack-token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, confidence: "high", source: "warden" },
    { name: "slack-webhook", regex: /\bhooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g, confidence: "high", source: "secret-redactor" },
  ],
  stripe: [
    { name: "stripe-secret-key", regex: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/g, confidence: "high", source: "warden" },
    { name: "stripe-webhook-secret", regex: /\bwhsec_[A-Za-z0-9]{32,}/g, confidence: "high", source: "secret-redactor" },
  ],
  twilio: [{ name: "twilio-api-key", regex: /\bSK[0-9a-fA-F]{32}\b/g, confidence: "medium", source: "warden" }],
  sendgrid: [{ name: "sendgrid-api-key", regex: /\bSG\.[A-Za-z0-9_-]{22,}\.[A-Za-z0-9_-]{22,}/g, confidence: "high", source: "warden" }],
  postman: [{ name: "postman-api-key", regex: /\bPMAK-[A-Za-z0-9-]{50,}/g, confidence: "high", source: "secret-redactor" }],
  datadog: [{ name: "datadog-api-key", regex: /\bdd[a-z]{1,2}_[A-Za-z0-9]{32,40}/g, confidence: "low", source: "secret-redactor" }],
  discord: [{ name: "discord-bot-token", regex: /\b[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27,}/g, confidence: "medium", source: "warden" }],
  mailgun: [{ name: "mailgun-api-key", regex: /\bkey-[0-9a-zA-Z]{32}/g, confidence: "high", source: "warden" }],
  mailchimp: [{ name: "mailchimp-api-key", regex: /\b[a-f0-9]{32}-us\d{1,2}\b/g, confidence: "medium", source: "secret-redactor" }],
  linear: [{ name: "linear-api-key", regex: /\blin_api_[A-Za-z0-9]{40,}/g, confidence: "high", source: "secret-redactor" }],
  shopify: [
    { name: "shopify-access-token", regex: /\bshpat_[a-fA-F0-9]{20,}/g, confidence: "high", source: "secret-redactor" },
    { name: "shopify-custom-app", regex: /\bshpca_[a-fA-F0-9]{20,}/g, confidence: "high", source: "secret-redactor" },
    { name: "shopify-private-app", regex: /\bshppa_[a-fA-F0-9]{20,}/g, confidence: "high", source: "secret-redactor" },
    { name: "shopify-shared-secret", regex: /\bshpss_[a-fA-F0-9]{20,}/g, confidence: "high", source: "secret-redactor" },
  ],
  square: [
    { name: "square-access-token", regex: /\bsq0atp-[A-Za-z0-9_-]{22,}/g, confidence: "high", source: "secret-redactor" },
    { name: "square-oauth-secret", regex: /\bsq0csp-[A-Za-z0-9_-]{43}/g, confidence: "high", source: "secret-redactor" },
  ],
  docker: [
    { name: "docker-swarm-token", regex: /\bSWMTKN-1-[a-z0-9]{49,}-[a-z0-9]{25,}/g, confidence: "high", source: "warden" },
    { name: "docker-registry-auth", regex: /(?<="auth"\s*:\s*")[A-Za-z0-9+/=]{20,}(?=")/g, confidence: "high", source: "warden" },
    { name: "docker-pat", regex: /\bdckr_pat_[A-Za-z0-9_-]{24,}/g, confidence: "high", source: "secret-redactor" },
    {
      name: "docker-run-env-secret",
      regex: /(?<=docker\s+(?:run|exec|create)\s+.*(?:-e|--env)\s+(?:[A-Z_]*(?:SECRET|TOKEN|PASSWORD|KEY|CREDENTIAL|AUTH)[A-Z_]*)=)[^\s]+/gi,
      confidence: "high",
      source: "warden",
    },
    {
      name: "docker-build-arg-secret",
      regex: /(?<=--build-arg\s+(?:[A-Z_]*(?:SECRET|TOKEN|PASSWORD|KEY|CREDENTIAL|AUTH)[A-Z_]*)=)[^\s]+/gi,
      confidence: "high",
      source: "warden",
    },
  ],

  // ------------------------------------------------------------- Registries
  npm: [{ name: "npm-token", regex: /\bnpm_[A-Za-z0-9]{36,}/g, confidence: "high", source: "warden" }],
  pypi: [{ name: "pypi-token", regex: /\bpypi-[A-Za-z0-9_-]{50,}/g, confidence: "high", source: "warden" }],
  rubygems: [{ name: "rubygems-key", regex: /\brubygems_[A-Za-z0-9]{48}/g, confidence: "high", source: "secret-redactor" }],

  // ------------------------------------------------------------------ Cloud
  azure: [
    {
      name: "azure-connection-string",
      regex: /DefaultEndpointsProtocol=https?;AccountName=[^;\s]+;AccountKey=[A-Za-z0-9+/=]{40,};/g,
      confidence: "high",
      source: "warden",
    },
    { name: "azure-storage-key", regex: /\bAccountKey=[A-Za-z0-9+/]{86}==/g, confidence: "high", source: "secret-redactor" },
    { name: "azure-sas-token", regex: /[?&](?:sig|sv)=[^&\s'"]{10,}(?:&[a-z]{2,3}=[^&\s'"]+){2,}/g, confidence: "high", source: "warden" },
    {
      name: "azure-ad-client-secret",
      regex: /(?<=(?:AZURE_CLIENT_SECRET|client_secret|clientSecret)\s*[=:]\s*['"]?)[A-Za-z0-9~._-]{30,}/g,
      confidence: "medium",
      source: "warden",
    },
  ],
  terraform: [
    { name: "terraform-state-sensitive", regex: /(?<="sensitive":\s*true,\s*"value":\s*")[^"]+/g, confidence: "high", source: "warden" },
    { name: "terraform-var-secret", regex: /(?<=TF_VAR_[a-z_]*(?:secret|password|token|key)[a-z_]*=)[^\s]+/gi, confidence: "high", source: "warden" },
    { name: "terraform-cloud-token", regex: /\b[A-Za-z0-9]{14}\.atlasv1\.[A-Za-z0-9_-]{60,}/g, confidence: "high", source: "secret-redactor" },
    { name: "pulumi-token", regex: /\bpul-[a-f0-9]{40}/g, confidence: "high", source: "secret-redactor" },
    { name: "pulumi-passphrase", regex: /(?<=PULUMI_CONFIG_PASSPHRASE\s*[=:]\s*['"]?)[^\s'"]+/g, confidence: "high", source: "warden" },
  ],
  vault: [
    { name: "vault-token-hvs", regex: /\bhvs\.[A-Za-z0-9_-]{24,}/g, confidence: "high", source: "warden" },
    { name: "vault-token-s", regex: /(?<=(?:VAULT_TOKEN|X-Vault-Token)\s*[=:]\s*['"]?)s\.[A-Za-z0-9]{24,}/g, confidence: "high", source: "warden" },
  ],
  heroku: [
    {
      name: "heroku-api-key",
      regex: /(?<=(?:HEROKU_API_KEY|heroku_api_key)\s*[=:\s"']+)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
      confidence: "high",
      source: "warden",
    },
  ],
  vercel: [
    { name: "vercel-token", regex: /\bvercel_[A-Za-z0-9]{24,}/g, confidence: "high", source: "secret-redactor" },
    {
      name: "vercel-token-env",
      regex: /(?<=(?:VERCEL_TOKEN|vercel_token)\s*[=:]\s*['"]?)[A-Za-z0-9]{24,}/g,
      confidence: "medium",
      source: "warden",
    },
  ],
  supabase: [
    {
      name: "supabase-service-role-key",
      regex: /(?<=(?:SUPABASE_SERVICE_ROLE_KEY|supabase_service_role_key|service_role)\s*[=:]\s*['"]?)eyJ[A-Za-z0-9_-]{100,}/g,
      confidence: "high",
      source: "warden",
    },
  ],
  digitalocean: [
    { name: "digitalocean-pat", regex: /\bdop_v1_[a-f0-9]{64}/g, confidence: "high", source: "warden" },
    { name: "digitalocean-oauth", regex: /\bdoo_v1_[a-f0-9]{64}/g, confidence: "high", source: "secret-redactor" },
  ],
  cloudflare: [
    {
      name: "cloudflare-api-token",
      regex: /(?<=(?:CF_API_TOKEN|CLOUDFLARE_API_TOKEN)\s*[=:]\s*['"]?)[A-Za-z0-9_-]{40,}/g,
      confidence: "high",
      source: "warden",
    },
    {
      name: "cloudflare-global-api-key",
      regex: /(?<=(?:CF_API_KEY|CLOUDFLARE_API_KEY)\s*[=:]\s*['"]?)[0-9a-f]{37}/g,
      confidence: "high",
      source: "warden",
    },
  ],

  // -------------------------------------------------------- Observabilidad
  observability: [
    {
      name: "sentry-dsn",
      regex: /https:\/\/[a-f0-9]{32}@[^\s/]+\.ingest\.sentry\.io\/[0-9]+/g,
      confidence: "high",
      source: "secret-redactor",
    },
    { name: "grafana-api-key", regex: /\bglc_[A-Za-z0-9_-]{32,}/g, confidence: "high", source: "secret-redactor" },
    { name: "doppler-token", regex: /\bdp\.st\.[A-Za-z0-9_-]{40,}/g, confidence: "high", source: "secret-redactor" },
  ],

  // --------------------------------------------------------- Claves privadas
  pem: [
    { name: "rsa-private-key", regex: /-----BEGIN RSA PRIVATE KEY-----[\s\S]*?-----END RSA PRIVATE KEY-----/g, confidence: "high", source: "warden" },
    { name: "openssh-private-key", regex: /-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----/g, confidence: "high", source: "warden" },
    { name: "dsa-private-key", regex: /-----BEGIN DSA PRIVATE KEY-----[\s\S]*?-----END DSA PRIVATE KEY-----/g, confidence: "high", source: "warden" },
    { name: "ec-private-key", regex: /-----BEGIN EC PRIVATE KEY-----[\s\S]*?-----END EC PRIVATE KEY-----/g, confidence: "high", source: "warden" },
    { name: "encrypted-private-key", regex: /-----BEGIN ENCRYPTED PRIVATE KEY-----[\s\S]*?-----END ENCRYPTED PRIVATE KEY-----/g, confidence: "high", source: "warden" },
    { name: "pkcs8-private-key", regex: /-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g, confidence: "high", source: "warden" },
    { name: "pgp-private-key", regex: /-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]*?-----END PGP PRIVATE KEY BLOCK-----/g, confidence: "high", source: "warden" },
    { name: "age-secret-key", regex: /\bAGE-SECRET-KEY-1[A-Za-z0-9]{58}/g, confidence: "high", source: "secret-redactor" },
    { name: "ssh-public-key", regex: /\bssh-(?:rsa|ed25519|dss)\s+[A-Za-z0-9+/]{60,}={0,2}/g, confidence: "medium", source: "secret-redactor" },
    { name: "ssh-ecdsa-key", regex: /\becdsa-sha2-nistp(?:256|384|521)\s+[A-Za-z0-9+/]{60,}={0,2}/g, confidence: "medium", source: "secret-redactor" },
  ],

  // ------------------------------------------------------------------ Auth
  jwt: [
    { name: "jwt", regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, confidence: "high", source: "warden" },
  ],
  bearer: [
    { name: "bearer-token", regex: /(?<=Bearer\s+)[A-Za-z0-9\-._~+/]{20,}=*/g, confidence: "medium", source: "warden" },
    { name: "basic-auth", regex: /(?<=Basic\s+)[A-Za-z0-9+/]{10,}={0,2}/g, confidence: "medium", source: "secret-redactor" },
  ],

  // -------------------------------------------------------------- Databases
  database: [
    {
      name: "db-uri-credentials",
      regex: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s/]+:([^@\s/]{6,})@/gi,
      confidence: "high",
      source: "apex",
    },
    { name: "mongodb-connection-string", regex: /\bmongodb(?:\+srv)?:\/\/[^\s'"]+/g, confidence: "medium", source: "warden" },
    { name: "postgres-connection-string", regex: /\bpostgres(?:ql)?:\/\/[^\s'"]+/g, confidence: "medium", source: "warden" },
    { name: "mysql-connection-string", regex: /\bmysql:\/\/[^\s'"]+/g, confidence: "medium", source: "warden" },
    { name: "redis-connection-string", regex: /\bredis(?:s)?:\/\/[^\s'"]+/g, confidence: "low", source: "warden" },
    { name: "generic-connection-string", regex: /(?:Server|Data Source|Host)=[^;]+;.*(?:Password|Pwd)=[^;]+/gi, confidence: "medium", source: "warden" },
  ],

  // -------------------------------- Asignaciones genéricas de env (ruidoso)
  env: [
    {
      name: "env-assignment",
      regex: /\b(?:[A-Z0-9_]{0,30}(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|PRIVATE_KEY|ACCESS_KEY|ENCRYPTION_KEY|SIGNING_KEY)[A-Z0-9_]{0,30})\s*[=:]\s*['"]?([^\s'"#]{8,})['"]?/g,
      confidence: "medium",
      source: "secret-redactor",
    },
  ],

  // ------------------------------------------------------------ Kubernetes
  kubernetes: [
    { name: "k8s-secret-data-value", regex: /(?<=data:\s*\n(?:\s+\w+:\s*[^\n]*\n)*\s+\w+:\s*)[A-Za-z0-9+/=]{20,}/g, confidence: "medium", source: "warden" },
    { name: "kubeconfig-token", regex: /(?<=token:\s*)[A-Za-z0-9_.-]{20,}/g, confidence: "medium", source: "warden" },
    { name: "kubeconfig-client-key-data", regex: /(?<=client-key-data:\s*)[A-Za-z0-9+/=\n]{50,}/g, confidence: "high", source: "warden" },
    { name: "kubeconfig-client-cert-data", regex: /(?<=client-certificate-data:\s*)[A-Za-z0-9+/=\n]{50,}/g, confidence: "high", source: "warden" },
    { name: "helm-set-secret", regex: /(?<=helm\s+.*--set\s+[a-zA-Z._]*(?:secret|password|token|key|credential|auth)[a-zA-Z._]*=)[^\s,]+/gi, confidence: "high", source: "warden" },
    { name: "k8s-service-account-token", regex: /(?<=serviceAccountToken:\s*['"]?)[A-Za-z0-9_.-]{50,}/g, confidence: "high", source: "warden" },
  ],

  // -------------------------------------------------------------------- PII
  // Desactivado por defecto: redactar emails/teléfonos del contexto completo
  // es muy agresivo. Actívalo explícitamente si lo necesitas.
  pii: [
    { name: "pii-email", regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/gi, confidence: "medium", source: "warden" },
    { name: "pii-us-phone", regex: /(?<!\d)(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}(?!\d)/g, confidence: "low", source: "warden" },
    { name: "pii-us-ssn", regex: /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g, confidence: "medium", source: "warden" },
    {
      name: "pii-credit-card",
      regex: /(?<!\d)(?:\d{4}[-\s]?){3}\d{3,4}(?!\d)/g,
      confidence: "high",
      source: "warden",
      validate: luhnCheck,
    },
  ],
  network: [
    {
      name: "pii-ipv4",
      regex: /(?<!\d)(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)(?!\d)/g,
      confidence: "low",
      source: "warden",
      validate: isPublicIp,
    },
  ],
}

/** Bundles ACTIVOS por defecto (el resto hay que activarlos explícitamente). */
export const DEFAULT_BUNDLES: readonly string[] = [
  "aws", "github", "gitlab", "slack", "jwt", "pem", "bearer", "env",
  "openai", "anthropic", "google", "stripe", "npm", "database",
  "azure", "terraform", "vault", "heroku", "vercel", "supabase", "digitalocean",
  "cloudflare", "observability", "pypi", "rubygems", "twilio", "sendgrid",
  "postman", "mailgun", "mailchimp", "linear", "shopify", "square", "docker",
  "kubernetes", "cohere", "huggingface", "discord",
]

/** Bundles opt-in (ruidosos o de PII): no se activan por defecto. */
export const OPT_IN_BUNDLES: readonly string[] = ["pii", "network", "datadog"]

/** Nombres de bundle disponibles. */
export function availableBundles(): string[] {
  return Object.keys(BUNDLES)
}

/**
 * Compila la lista de patrones activos: bundles por nombre + patrones propios.
 * Filtra por confianza mínima. Los patrones inválidos se ignoran con un aviso.
 */
export function compilePatterns(
  bundleNames: string[],
  customSources: string[],
  minConfidence: PatternConfidence = "medium",
): PatternDefinition[] {
  const rank: Record<PatternConfidence, number> = { low: 0, medium: 1, high: 2 }
  const threshold = rank[minConfidence]

  const patterns: PatternDefinition[] = []

  for (const name of bundleNames) {
    const bundle = BUNDLES[name]
    if (!bundle) {
      console.warn(`[apex.redact] Bundle desconocido: "${name}" (disponibles: ${availableBundles().join(", ")})`)
      continue
    }
    for (const pattern of bundle) {
      if (rank[pattern.confidence] >= threshold) patterns.push(pattern)
    }
  }

  customSources.forEach((source, index) => {
    try {
      patterns.push({ name: `custom-${index}`, regex: new RegExp(source, "g"), confidence: "high", source: "apex" })
    } catch (error) {
      console.warn(`[apex.redact] Patrón inválido #${index} (${source}): ${String(error)}`)
    }
  })

  return patterns
}
