export type ServiceState = "stopped" | "starting" | "running" | "stopping" | "error";

export interface ServiceStatus {
  readonly state: ServiceState;
  readonly pid?: number;
  readonly port?: number;
  readonly startedAt?: number;
  readonly error?: string;
}

export interface LocalspaceConfigSnapshot {
  readonly host?: string;
  readonly port?: number;
  readonly allowedRoots?: ReadonlyArray<string>;
  readonly publicBaseUrl?: string | null;
}

export interface UserFilesSnapshot {
  readonly dir: string;
  readonly configPath: string;
  readonly authPath: string;
  readonly configExists: boolean;
  readonly authExists: boolean;
  readonly config: LocalspaceConfigSnapshot;
}

export interface AppState {
  readonly configured: boolean;
  readonly service: ServiceStatus;
  readonly files: UserFilesSnapshot | null;
  readonly filesError?: string;
  readonly appVersion: string;
  readonly coreVersion: string | null;
  readonly platform: NodeJS.Platform;
}

export interface ConnectionInfo {
  readonly localMcpUrl: string;
  readonly publicMcpUrl: string | null;
  readonly maskedOwnerToken: string | null;
}

export interface WizardInput {
  readonly roots: ReadonlyArray<string>;
  readonly port: number;
  readonly publicBaseUrl: string;
}

export interface WizardResult {
  readonly ok: boolean;
  readonly ownerToken?: string;
  readonly error?: string;
}

export interface DoctorReportView {
  readonly ok: boolean;
  readonly groups: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly ok: boolean;
    readonly detail: string;
  }>;
  readonly error?: string;
}

export interface LogEntry {
  readonly timestamp: number;
  readonly stream: "stdout" | "stderr" | "app";
  readonly line: string;
}

export interface DesktopSettings {
  readonly launchAtStartup: boolean;
  readonly closeToTray: boolean;
}

export interface FolderPickResult {
  readonly canceled: boolean;
  readonly paths: ReadonlyArray<string>;
}
