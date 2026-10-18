import type {
  Classification,
  Part,
  SourceOccurrence,
  Vec3,
} from "../domain/model";
import type { ImportProgress } from "../domain/import-progress";

/** Browser-safe contract: these identifiers are resolved by the local server. No credentials cross this boundary. */
export interface LiveOnshapeSelection {
  documentId: string;
  versionId: string;
  elementId: string;
  elementType: "assembly" | "partstudio";
  configuration: string;
  partIds?: string[];
  spares?: Record<string, number>;
  classifications?: Record<string, Classification>;
  excludePurchased?: boolean;
  assemblyScope?:string[];
}
export interface OnshapeCapability {
  available: boolean;
  mode: "disconnected" | "configured";
  verified: boolean;
  reason: string;
  authentication:
    | "server-oauth-token-file"
    | "injected-provider"
    | "not-configured";
  exportMode: "sync-stl" | "async-stl";
  apiVersion: string;
}
export interface OnshapeCatalogItem {
  id: string;
  name: string;
  createdAt?:string;
}
export interface OnshapePage {
  items: OnshapeCatalogItem[];
  nextOffset?: number;
}
export interface OnshapeElement extends OnshapeCatalogItem {
  type: "assembly" | "partstudio";
}
export interface OnshapeConfigurationParameter {
  id: string;
  name: string;
  type: "enum" | "boolean" | "quantity" | "string";
  defaultValue: string;
  options?: OnshapeCatalogItem[];
}
export interface OnshapeConfigurations {
  parameters: OnshapeConfigurationParameter[];
  defaultConfiguration: string;
}
export interface LiveOnshapePartOption {
  id: string;
  partId: string;
  name: string;
  documentId: string;
  versionId?: string;
  microversionId?: string;
  elementId: string;
  configuration: string;
  quantity: number;
  occurrences: SourceOccurrence[];
  classification: Classification;
  available: boolean;
  unavailableReason?: string;
  dimensions?: Vec3;
  materialHint?: string;
  colorHint?: string;
  linkedDocumentId?: string;
  assemblyMemberships?:import('../domain/model').AssemblyMembership[];
  originElementName?:string;
  standardContent?:boolean;
}
export interface OnshapeImportJob {
  id: string;
  state: "queued" | "running" | "done" | "failed" | "cancelled";
  progress: ImportProgress;
  parts?: Part[];
  error?: string;
  code?: string;
}
export class OnshapeApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
    this.name = "OnshapeApiError";
  }
}
/** Narrow same-origin client. Access tokens stay in the server-owned credential provider. */
export class HttpOnshapeAdapter {
  constructor(
    private fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
    private base = "/api/onshape",
  ) {}
  private async request<T>(
    pathname: string,
    options: RequestInit = {},
  ): Promise<T> {
    const response = await this.fetcher(this.base + pathname, {
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers },
    });
    const data = await response
      .json()
      .catch(() => ({
        error:
          "The local Onshape service returned an unreadable response. Retry or check that Foundry is running.",
      }));
    if (!response.ok)
      throw new OnshapeApiError(
        data.error ?? `Onshape request failed (${response.status}).`,
        response.status,
        data.code,
      );
    return data as T;
  }
  capability() {
    return this.request<OnshapeCapability>("/capability");
  }
  listDocuments(query = "", offset = 0) {
    return this.request<OnshapePage>(
      `/documents?q=${encodeURIComponent(query)}&offset=${offset}`,
    );
  }
  listVersions(documentId: string, offset = 0) {
    return this.request<OnshapePage>(
      `/documents/${encodeURIComponent(documentId)}/versions?offset=${offset}`,
    );
  }
  listElements(documentId: string, versionId: string) {
    return this.request<OnshapeElement[]>(
      `/documents/${encodeURIComponent(documentId)}/versions/${encodeURIComponent(versionId)}/elements`,
    );
  }
  getConfigurations(documentId: string, versionId: string, elementId: string) {
    return this.request<OnshapeConfigurations>(
      `/documents/${encodeURIComponent(documentId)}/versions/${encodeURIComponent(versionId)}/elements/${encodeURIComponent(elementId)}/configurations`,
    );
  }
  async listParts(selection: LiveOnshapeSelection) {
    return (
      await this.request<{ parts: LiveOnshapePartOption[] }>("/parts", {
        method: "POST",
        body: JSON.stringify(selection),
      })
    ).parts;
  }
  async listRobotParts(selection:LiveOnshapeSelection){return(await this.request<{parts:LiveOnshapePartOption[]}>('/robot/parts',{method:'POST',body:JSON.stringify(selection)})).parts;}
  async importParts(
    selection: LiveOnshapeSelection,
    options: {
      signal?: AbortSignal;
      onProgress?: (progress: ImportProgress) => void;
      pollIntervalMs?: number;
    } = {},
  ): Promise<Part[]> {
    if (options.signal?.aborted)
      throw new DOMException(
        "Geometry transfer cancelled. No parts were imported.",
        "AbortError",
      );
    // Do not abort creation: its response gives us the job id needed to cancel an in-flight server translation.
    let job = await this.request<OnshapeImportJob>("/imports", {
      method: "POST",
      body: JSON.stringify(selection),
    });
    const cancel = () => {
      void this.request(`/imports/${encodeURIComponent(job.id)}/cancel`, {
        method: "POST",
      }).catch(() => {});
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    try {
      if (options.signal?.aborted) {
        cancel();
        throw new DOMException(
          "Geometry transfer cancelled. No parts were imported.",
          "AbortError",
        );
      }
      for (;;) {
        options.onProgress?.(job.progress);
        if (options.signal?.aborted || job.state === "cancelled")
          throw new DOMException(
            "Geometry transfer cancelled. No parts were imported.",
            "AbortError",
          );
        if (job.state === "failed")
          throw new OnshapeApiError(
            job.error ?? "Onshape geometry transfer failed.",
            502,
            job.code,
          );
        if (job.state === "done") {
          if (!job.parts?.length)
            throw new OnshapeApiError(
              "Onshape import completed without geometry. Retry the selection.",
              502,
            );
          return job.parts;
        }
        await new Promise<void>((resolve) =>
          setTimeout(resolve, options.pollIntervalMs ?? 350),
        );
        job = await this.request<OnshapeImportJob>(
          `/imports/${encodeURIComponent(job.id)}`,
        );
      }
    } finally {
      options.signal?.removeEventListener("abort", cancel);
    }
  }
}
