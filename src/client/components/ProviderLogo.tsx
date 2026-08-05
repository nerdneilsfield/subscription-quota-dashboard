import type { ReactNode } from "react"
import mimoLogo from "../assets/xiaomi-mimo.png"
import doubaoLogo from "../assets/doubao.png"
import zhipuLogo from "../assets/zhipu.png"
import kimiLogo from "../assets/kimi.png"

interface ProviderLogoProps {
  provider?: string
  label: string
}

/** Official brand marks cached inline; each keeps its native viewBox. */
export function ProviderLogo({ provider, label }: ProviderLogoProps) {
  const key = normalizeProvider(provider ?? label)
  const logo = LOGOS[key]

  return (
    <span className={`provider-logo provider-logo--${key}`} title={label}>
      {logo?.kind === "image" ? (
        <img src={logo.src} role="img" aria-label={`${label} logo`} />
      ) : logo ? (
        <svg viewBox={logo.viewBox} role="img" aria-label={`${label} logo`} fill="currentColor">
          {logo.paths}
        </svg>
      ) : (
        <span aria-hidden="true">{label.slice(0, 1)}</span>
      )}
    </span>
  )
}

function normalizeProvider(value: string): string {
  const normalized = value.toLowerCase()
  if (normalized === "codex" || normalized.includes("openai")) return "openai"
  if (normalized.includes("claude") || normalized.includes("anthropic")) return "claude"
  if (normalized === "xai" || normalized.includes("grok")) return "grok"
  if (normalized.includes("poe")) return "poe"
  if (normalized.includes("cursor")) return "cursor"
  if (normalized.includes("opencode")) return "opencode"
  if (normalized.includes("mimo") || normalized.includes("xiaomi")) return "mimo"
  if (normalized.includes("doubao") || normalized.includes("volcengine")) return "doubao"
  if (normalized.includes("zhipu") || normalized.includes("bigmodel") || normalized.includes("glm")) return "zhipu"
  if (normalized.includes("kimi") || normalized.includes("moonshot")) return "kimi"
  return "fallback"
}

// Paths follow the providers' current public brand marks; kept local so the
// dashboard neither depends on a third-party CDN nor leaks visits to one.
type LogoDefinition =
  | { kind?: "svg"; viewBox: string; paths: ReactNode }
  | { kind: "image"; src: string }

const LOGOS: Record<string, LogoDefinition> = {
  openai: { viewBox: "0 0 24 24", paths: <path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 0 0-.856 0l-5.97 3.473Zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 0 1 .476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163ZM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898ZM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128Zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472Zm-5.637-5.303-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 0 1 4.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 0 1-.476 0Zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523Zm5.899 2.83a5.947 5.947 0 0 0 5.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0 0 10.205 0a5.947 5.947 0 0 0-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 0 0 4.162 1.713Z" /> },
  claude: { viewBox: "0 0 24 24", paths: <path d="m4.709 15.955 4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-5.037-.17-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321 8.585.673h.389l.055-.157-.237-.195-4.91-3.284-2.06-1.463-.364-.462-.158-1.008.656-.722.881.06 5.793 4.508.365.304.145-.103.019-.073-3.157-5.531-.17-.619-.104-.729L6.283.134 6.696 0l.996.134.42.364 3.633 7.571.243.832.091.255h.158L12.98 1.754l.376-.91.747-.492.584.28.48.685-.067.444-1.209 6.696h.212l4.307-5.376.547-.431h1.033l.76 1.129-.34 1.166-4.268 5.665.188-.02 5.232-1.2.833.388.091.395-.328.807-6.913 1.57.049.061 5.23.407.79.522.474.638-.079.485-1.215.62-5.141-1.228h-.182v.11l6.48 5.208.127.578-.322.455-.34-.049-6.39-5.024h-.128v.17l2.911 4.17.122 1.08-.17.353-.608.213-.668-.122-4.072-6.035-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747 1.482-7.362-.14.018-5.34 6.757-.414.164-.717-.37.067-.662.401-.589 4.758-6.004-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.902-1.306Z" /> },
  grok: { viewBox: "0 0 24 24", paths: <path d="m9.27 15.29 7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383L24 .5l-3.301 3.305v-.01L9.267 15.292m-1.644 1.431c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 0 0-1.829-1A8.975 8.975 0 0 0 5.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815" /> },
  poe: { viewBox: "0 0 24 24", paths: <><path d="M20.708 6.876a1.412 1.412 0 0 0-1.029-.415 2.019 2.019 0 0 1-2.026-2.023A1.415 1.415 0 0 0 16.254 3H4.871A1.412 1.412 0 0 0 3.47 4.434a2.026 2.026 0 0 1-2.025 2.025A1.414 1.414 0 0 0 0 7.883v3.642a1.414 1.414 0 0 0 1.444 1.42 2.025 2.025 0 0 1 2.025 2.02v3.693a.5.5 0 0 0 .89.313l2.051-2.567h9.843a1.412 1.412 0 0 0 1.4-1.434c0-1.12.904-2.025 2.026-2.025a1.412 1.412 0 0 0 1.446-1.42V7.88c0-.363-.14-.727-.417-1.005Zm-2.42 4.687a2.025 2.025 0 0 1-2.025 2.005H4.861a2.025 2.025 0 0 1-2.025-2.005v-3.72A2.026 2.026 0 0 1 4.86 5.838h11.4a2.026 2.026 0 0 1 2.026 2.005v3.72Z"/><path d="M7.413 7.57A1.422 1.422 0 0 0 5.99 8.99v1.422a1.422 1.422 0 1 0 2.844 0V8.99c0-.784-.636-1.422-1.422-1.422Zm6.297 0a1.422 1.422 0 0 0-1.422 1.421v1.422a1.422 1.422 0 1 0 2.844 0V8.99c0-.784-.636-1.422-1.422-1.422Z"/><path d="m7.292 22.643 1.993-2.492h9.844a1.413 1.413 0 0 0 1.4-1.434 2.025 2.025 0 0 1 2.017-2.027A1.409 1.409 0 0 0 24 15.27v-3.594c0-.344-.113-.68-.324-.951l-.397-.519v4.127a1.415 1.415 0 0 1-1.444 1.42 2.026 2.026 0 0 0-2.025 2.025 1.415 1.415 0 0 1-1.402 1.436H8.565l-2.169 2.712a.574.574 0 0 0 .896.715Z"/></> },
  cursor: { viewBox: "0 0 512 512", paths: <path d="m415.035 156.35-151.503-87.4695c-4.865-2.8094-10.868-2.8094-15.733 0l-151.4969 87.4695c-4.0897 2.362-6.6146 6.729-6.6146 11.459v176.383c0 4.73 2.5249 9.097 6.6146 11.458l151.5039 87.47c4.865 2.809 10.868 2.809 15.733 0l151.504-87.47c4.089-2.361 6.614-6.728 6.614-11.458v-176.383c0-4.73-2.525-9.097-6.614-11.459zm-9.516 18.528-146.255 253.32c-.988 1.707-3.599 1.01-3.599-.967v-165.872c0-3.314-1.771-6.379-4.644-8.044l-143.645-82.932c-1.707-.988-1.01-3.599.968-3.599h292.509c4.154 0 6.75 4.503 4.673 8.101h-.007z" /> },
  opencode: { viewBox: "0 0 300 300", paths: <g transform="translate(30 0)"><path d="M180 240H60V120H180V240Z" opacity=".35"/><path fillRule="evenodd" d="M180 60H60V240H180V60ZM240 300H0V0H240V300Z" clipRule="evenodd" /></g> },
  mimo: { kind: "image", src: mimoLogo },
  doubao: { kind: "image", src: doubaoLogo },
  zhipu: { kind: "image", src: zhipuLogo },
  kimi: { kind: "image", src: kimiLogo },
}
