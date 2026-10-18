export interface ImportProgress {phase:'queued'|'translating'|'downloading'|'validating'|'cached'|'done'|'cancelled'|'failed';percent:number;message:string;partId?:string;}
