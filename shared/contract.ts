// HTTP contract between the acquisition backend and the frontend.
// Types only (no runtime code): imported by both server/ and src/.

export type JobStatus = 'queued' | 'fetching_metadata' | 'downloading' | 'ready' | 'failed';

export type ErrorCode =
  | 'INVALID_URL' // not a recognized public YouTube video URL
  | 'UNAVAILABLE' // private, removed, restricted or otherwise unavailable
  | 'LIVE' // live stream (or scheduled live)
  | 'TOO_LONG' // longer than the configured maximum duration
  | 'TOO_LARGE' // file larger than the configured maximum size
  | 'BLOCKED' // the extractor was blocked (bot check, HTTP 429)
  | 'TIMEOUT' // the job exceeded its time limit
  | 'DOWNLOAD_FAILED' // any other acquisition failure
  | 'BUSY' // queue is full
  | 'RATE_LIMITED' // too many requests from this client
  | 'NOT_FOUND'; // unknown or already delivered job

export interface CreateJobRequest {
  url: string;
}

export interface CreateJobResponse {
  jobId: string;
}

export interface JobResponse {
  jobId: string;
  status: JobStatus;
  errorCode?: ErrorCode;
}

export interface ApiError {
  errorCode: ErrorCode;
}
