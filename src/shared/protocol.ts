export type CameraInfo = {
  id: string;
  name: string;
  online: boolean;
  width: number;
  height: number;
  fps: number;
};

export type JobState = "capturing" | "processing" | "ready" | "error";
export type JobStatus = {
  jobId: string;
  clipNumber: number;
  state: JobState;
  error?: string;
  createdAt: number;
};

export type ClientMessage =
  | { type: "register"; role: "camera"; name: string }
  | { type: "register"; role: "control" }
  | { type: "ntp"; clientTime: number }
  | { type: "cameraStatus"; width: number; height: number; fps: number }
  | { type: "hb" };

export type ServerMessage =
  | { type: "registered"; cameraId: string }
  | { type: "ntpReply"; clientTime: number; serverTime: number }
  | { type: "record"; jobId: string; t: number; windowSec: number }
  | { type: "state"; cameras: CameraInfo[]; clipDurationSeconds: number; jobs: JobStatus[] }
  | { type: "jobUpdate"; job: JobStatus };
