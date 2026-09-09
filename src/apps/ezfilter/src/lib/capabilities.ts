import {
  Shield,
  Plug,
  Globe,
  ArrowDownToLine,
  ScrollText,
  Timer,
  Tag,
  Database,
  Clock,
  Network,
} from "lucide-solid";

export interface CapabilityMeta {
  label: string;
  description: string;
  icon: typeof Shield;
}

export const CAPABILITY_META: Record<string, CapabilityMeta> = {
  handle_event_connect: {
    label: "Intercept Connections",
    description: "Decide which network connections should be intercepted by the proxy",
    icon: Plug,
  },
  handle_event_request: {
    label: "Handle Requests",
    description: "Inspect and modify outgoing HTTP requests before they reach the server",
    icon: Globe,
  },
  handle_event_response: {
    label: "Handle Responses",
    description: "Inspect and modify incoming HTTP responses before they reach the browser",
    icon: ArrowDownToLine,
  },
  handle_event_inbound_content: {
    label: "Process Content",
    description: "Analyze and transform response body content by type (HTML, JSON, etc.)",
    icon: ScrollText,
  },
  handle_event_timer: {
    label: "Scheduled Tasks",
    description: "Run periodic tasks on a schedule defined by a CRON expression",
    icon: Timer,
  },
  logger: {
    label: "Logging",
    description: "Write messages to the host logging system",
    icon: ScrollText,
  },
  annotator: {
    label: "Annotate Content",
    description: "Extract features and attach metadata to proxied content",
    icon: Tag,
  },
  local_storage: {
    label: "Local Storage",
    description: "Store and retrieve key-value data that persists across requests",
    icon: Database,
  },
  clock: {
    label: "System Clock",
    description: "Access the current date and time from the host system",
    icon: Clock,
  },
};

export function getCapMeta(kind: string): CapabilityMeta {
  return CAPABILITY_META[kind] ?? {
    label: kind.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    description: `Plugin capability: ${kind}`,
    icon: Network,
  };
}
