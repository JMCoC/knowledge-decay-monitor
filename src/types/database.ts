export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      analyses: {
        Row: {
          attempt_count: number
          created_at: string
          error_code:
            | Database["public"]["Enums"]["analysis_failure_code"]
            | null
          finished_at: string | null
          fixed_cost: number
          id: string
          idempotency_key: string
          initiator_id: string
          lease_expires_at: string | null
          model_used: string | null
          operation_id: string | null
          output_schema_version: string
          pricing_version: string
          prompt_version: string
          provider_config: Json
          provider_used: string | null
          request_fingerprint: string
          reserved_credits: number
          retrieval_config: Json
          retry_of_analysis_id: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["analysis_job_status"]
          updated_at: string
          workspace_id: string
        }
        Insert: {
          attempt_count?: number
          created_at?: string
          error_code?:
            | Database["public"]["Enums"]["analysis_failure_code"]
            | null
          finished_at?: string | null
          fixed_cost: number
          id?: string
          idempotency_key: string
          initiator_id: string
          lease_expires_at?: string | null
          model_used?: string | null
          operation_id?: string | null
          output_schema_version: string
          pricing_version: string
          prompt_version: string
          provider_config: Json
          provider_used?: string | null
          request_fingerprint: string
          reserved_credits: number
          retrieval_config: Json
          retry_of_analysis_id?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["analysis_job_status"]
          updated_at?: string
          workspace_id: string
        }
        Update: {
          attempt_count?: number
          created_at?: string
          error_code?:
            | Database["public"]["Enums"]["analysis_failure_code"]
            | null
          finished_at?: string | null
          fixed_cost?: number
          id?: string
          idempotency_key?: string
          initiator_id?: string
          lease_expires_at?: string | null
          model_used?: string | null
          operation_id?: string | null
          output_schema_version?: string
          pricing_version?: string
          prompt_version?: string
          provider_config?: Json
          provider_used?: string | null
          request_fingerprint?: string
          reserved_credits?: number
          retrieval_config?: Json
          retry_of_analysis_id?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["analysis_job_status"]
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "analyses_initiator_id_workspace_id_fkey"
            columns: ["initiator_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "analyses_retry_of_analysis_id_workspace_id_fkey"
            columns: ["retry_of_analysis_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "analyses"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "analyses_retry_of_analysis_id_workspace_id_fkey"
            columns: ["retry_of_analysis_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "analysis_runs"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "analyses_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      analysis_documents: {
        Row: {
          analysis_id: string
          document_id: string
          role: Database["public"]["Enums"]["analysis_scope_role"]
          version_id: string
          workspace_id: string
        }
        Insert: {
          analysis_id: string
          document_id: string
          role: Database["public"]["Enums"]["analysis_scope_role"]
          version_id: string
          workspace_id: string
        }
        Update: {
          analysis_id?: string
          document_id?: string
          role?: Database["public"]["Enums"]["analysis_scope_role"]
          version_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "analysis_documents_analysis_id_workspace_id_fkey"
            columns: ["analysis_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "analyses"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "analysis_documents_analysis_id_workspace_id_fkey"
            columns: ["analysis_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "analysis_runs"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "analysis_documents_version_id_document_id_workspace_id_fkey"
            columns: ["version_id", "document_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "document_versions"
            referencedColumns: ["id", "document_id", "workspace_id"]
          },
        ]
      }
      credit_ledger: {
        Row: {
          amount: number
          analysis_id: string | null
          created_at: string
          event_type: Database["public"]["Enums"]["credit_event_type"]
          id: string
          workspace_id: string
        }
        Insert: {
          amount: number
          analysis_id?: string | null
          created_at?: string
          event_type: Database["public"]["Enums"]["credit_event_type"]
          id?: string
          workspace_id: string
        }
        Update: {
          amount?: number
          analysis_id?: string | null
          created_at?: string
          event_type?: Database["public"]["Enums"]["credit_event_type"]
          id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "credit_ledger_analysis_id_workspace_id_fkey"
            columns: ["analysis_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "analyses"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "credit_ledger_analysis_id_workspace_id_fkey"
            columns: ["analysis_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "analysis_runs"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "credit_ledger_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      document_chunks: {
        Row: {
          chunk_index: number
          created_at: string
          embedding: string
          id: string
          page_number: number | null
          section_heading: string | null
          text_content: string
          version_id: string
          workspace_id: string
        }
        Insert: {
          chunk_index: number
          created_at?: string
          embedding: string
          id?: string
          page_number?: number | null
          section_heading?: string | null
          text_content: string
          version_id: string
          workspace_id: string
        }
        Update: {
          chunk_index?: number
          created_at?: string
          embedding?: string
          id?: string
          page_number?: number | null
          section_heading?: string | null
          text_content?: string
          version_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_chunks_version_id_workspace_id_fkey"
            columns: ["version_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "document_versions"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      document_upload_attempts: {
        Row: {
          cleanup_checked_at: string | null
          cleanup_status: Database["public"]["Enums"]["upload_cleanup_status"]
          created_at: string
          id: string
          retired_at: string | null
          storage_path: string
          version_id: string
          workspace_id: string
        }
        Insert: {
          cleanup_checked_at?: string | null
          cleanup_status?: Database["public"]["Enums"]["upload_cleanup_status"]
          created_at?: string
          id: string
          retired_at?: string | null
          storage_path: string
          version_id: string
          workspace_id: string
        }
        Update: {
          cleanup_checked_at?: string | null
          cleanup_status?: Database["public"]["Enums"]["upload_cleanup_status"]
          created_at?: string
          id?: string
          retired_at?: string | null
          storage_path?: string
          version_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_upload_attempts_version_id_workspace_id_fkey"
            columns: ["version_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "document_versions"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      document_versions: {
        Row: {
          analysis_status: Database["public"]["Enums"]["analysis_status"]
          created_at: string
          current_upload_attempt_id: string | null
          document_id: string
          expected_sha256: string | null
          hash_source: Database["public"]["Enums"]["upload_hash_source"] | null
          id: string
          idempotency_key: string | null
          processing_lease_expires_at: string | null
          processing_operation_id: string | null
          processing_queued: boolean
          processing_started_at: string | null
          processing_status: Database["public"]["Enums"]["processing_status"]
          reference_set_at: string | null
          reference_set_by: string | null
          request_fingerprint: string | null
          size_bytes: number | null
          storage_path: string
          updated_at: string
          upload_confirmed_at: string | null
          upload_initiator_id: string | null
          upload_lease_expires_at: string | null
          upload_operation_id: string | null
          upload_state: Database["public"]["Enums"]["upload_state"] | null
          version_number: number
          version_status: Database["public"]["Enums"]["version_status"] | null
          workspace_id: string
        }
        Insert: {
          analysis_status?: Database["public"]["Enums"]["analysis_status"]
          created_at?: string
          current_upload_attempt_id?: string | null
          document_id: string
          expected_sha256?: string | null
          hash_source?: Database["public"]["Enums"]["upload_hash_source"] | null
          id?: string
          idempotency_key?: string | null
          processing_lease_expires_at?: string | null
          processing_operation_id?: string | null
          processing_queued?: boolean
          processing_started_at?: string | null
          processing_status?: Database["public"]["Enums"]["processing_status"]
          reference_set_at?: string | null
          reference_set_by?: string | null
          request_fingerprint?: string | null
          size_bytes?: number | null
          storage_path: string
          updated_at?: string
          upload_confirmed_at?: string | null
          upload_initiator_id?: string | null
          upload_lease_expires_at?: string | null
          upload_operation_id?: string | null
          upload_state?: Database["public"]["Enums"]["upload_state"] | null
          version_number: number
          version_status?: Database["public"]["Enums"]["version_status"] | null
          workspace_id?: string
        }
        Update: {
          analysis_status?: Database["public"]["Enums"]["analysis_status"]
          created_at?: string
          current_upload_attempt_id?: string | null
          document_id?: string
          expected_sha256?: string | null
          hash_source?: Database["public"]["Enums"]["upload_hash_source"] | null
          id?: string
          idempotency_key?: string | null
          processing_lease_expires_at?: string | null
          processing_operation_id?: string | null
          processing_queued?: boolean
          processing_started_at?: string | null
          processing_status?: Database["public"]["Enums"]["processing_status"]
          reference_set_at?: string | null
          reference_set_by?: string | null
          request_fingerprint?: string | null
          size_bytes?: number | null
          storage_path?: string
          updated_at?: string
          upload_confirmed_at?: string | null
          upload_initiator_id?: string | null
          upload_lease_expires_at?: string | null
          upload_operation_id?: string | null
          upload_state?: Database["public"]["Enums"]["upload_state"] | null
          version_number?: number
          version_status?: Database["public"]["Enums"]["version_status"] | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_versions_current_upload_attempt_fk"
            columns: ["current_upload_attempt_id", "id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "document_upload_attempts"
            referencedColumns: ["id", "version_id", "workspace_id"]
          },
          {
            foreignKeyName: "document_versions_document_id_workspace_id_fkey"
            columns: ["document_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "document_versions_document_id_workspace_id_fkey"
            columns: ["document_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "repository_documents"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "document_versions_reference_set_by_workspace_fk"
            columns: ["reference_set_by", "workspace_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "document_versions_upload_initiator_workspace_fk"
            columns: ["upload_initiator_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      documents: {
        Row: {
          active_version_id: string | null
          category: Database["public"]["Enums"]["document_category"]
          created_at: string
          id: string
          name: string
          owner_id: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          active_version_id?: string | null
          category: Database["public"]["Enums"]["document_category"]
          created_at?: string
          id?: string
          name: string
          owner_id?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Update: {
          active_version_id?: string | null
          category?: Database["public"]["Enums"]["document_category"]
          created_at?: string
          id?: string
          name?: string
          owner_id?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "documents_active_version_fk"
            columns: ["active_version_id", "id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "document_versions"
            referencedColumns: ["id", "document_id", "workspace_id"]
          },
          {
            foreignKeyName: "documents_owner_id_workspace_id_fkey"
            columns: ["owner_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "documents_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      finding_evidence: {
        Row: {
          analysis_id: string
          chunk_id: string
          document_id: string
          finding_id: string
          id: string
          page_number: number | null
          section: string | null
          section_heading: string | null
          snapshot: string
          version_id: string
          workspace_id: string
        }
        Insert: {
          analysis_id: string
          chunk_id: string
          document_id: string
          finding_id: string
          id?: string
          page_number?: number | null
          section?: string | null
          section_heading?: string | null
          snapshot: string
          version_id: string
          workspace_id: string
        }
        Update: {
          analysis_id?: string
          chunk_id?: string
          document_id?: string
          finding_id?: string
          id?: string
          page_number?: number | null
          section?: string | null
          section_heading?: string | null
          snapshot?: string
          version_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "finding_evidence_chunk_id_version_id_workspace_id_fkey"
            columns: ["chunk_id", "version_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "document_chunks"
            referencedColumns: ["id", "version_id", "workspace_id"]
          },
          {
            foreignKeyName: "finding_evidence_finding_id_analysis_id_workspace_id_fkey"
            columns: ["finding_id", "analysis_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "analysis_findings"
            referencedColumns: ["id", "analysis_id", "workspace_id"]
          },
          {
            foreignKeyName: "finding_evidence_finding_id_analysis_id_workspace_id_fkey"
            columns: ["finding_id", "analysis_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "findings"
            referencedColumns: ["id", "analysis_id", "workspace_id"]
          },
          {
            foreignKeyName: "finding_evidence_version_id_document_id_workspace_id_fkey"
            columns: ["version_id", "document_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "document_versions"
            referencedColumns: ["id", "document_id", "workspace_id"]
          },
        ]
      }
      findings: {
        Row: {
          analysis_id: string
          assignee_id: string | null
          confidence: number
          created_at: string
          explanation: string
          fingerprint: string
          id: string
          severity_current: Database["public"]["Enums"]["finding_severity"]
          severity_original: Database["public"]["Enums"]["finding_severity"]
          status: Database["public"]["Enums"]["finding_status"]
          type: Database["public"]["Enums"]["finding_type"]
          updated_at: string
          workspace_id: string
        }
        Insert: {
          analysis_id: string
          assignee_id?: string | null
          confidence: number
          created_at?: string
          explanation: string
          fingerprint: string
          id?: string
          severity_current: Database["public"]["Enums"]["finding_severity"]
          severity_original: Database["public"]["Enums"]["finding_severity"]
          status?: Database["public"]["Enums"]["finding_status"]
          type: Database["public"]["Enums"]["finding_type"]
          updated_at?: string
          workspace_id: string
        }
        Update: {
          analysis_id?: string
          assignee_id?: string | null
          confidence?: number
          created_at?: string
          explanation?: string
          fingerprint?: string
          id?: string
          severity_current?: Database["public"]["Enums"]["finding_severity"]
          severity_original?: Database["public"]["Enums"]["finding_severity"]
          status?: Database["public"]["Enums"]["finding_status"]
          type?: Database["public"]["Enums"]["finding_type"]
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "findings_analysis_id_workspace_id_fkey"
            columns: ["analysis_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "analyses"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "findings_analysis_id_workspace_id_fkey"
            columns: ["analysis_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "analysis_runs"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "findings_assignee_id_workspace_id_fkey"
            columns: ["assignee_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      notification_events: {
        Row: {
          analysis_id: string
          attempt_count: number
          created_at: string
          error_code: string | null
          id: string
          next_attempt_at: string | null
          recipient_id: string
          sent_at: string | null
          status: Database["public"]["Enums"]["notification_status"]
          type: Database["public"]["Enums"]["notification_type"]
          workspace_id: string
        }
        Insert: {
          analysis_id: string
          attempt_count?: number
          created_at?: string
          error_code?: string | null
          id?: string
          next_attempt_at?: string | null
          recipient_id: string
          sent_at?: string | null
          status?: Database["public"]["Enums"]["notification_status"]
          type: Database["public"]["Enums"]["notification_type"]
          workspace_id: string
        }
        Update: {
          analysis_id?: string
          attempt_count?: number
          created_at?: string
          error_code?: string | null
          id?: string
          next_attempt_at?: string | null
          recipient_id?: string
          sent_at?: string | null
          status?: Database["public"]["Enums"]["notification_status"]
          type?: Database["public"]["Enums"]["notification_type"]
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_events_analysis_id_workspace_id_fkey"
            columns: ["analysis_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "analyses"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "notification_events_analysis_id_workspace_id_fkey"
            columns: ["analysis_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "analysis_runs"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "notification_events_recipient_id_workspace_id_fkey"
            columns: ["recipient_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          email: string
          full_name: string
          id: string
          role: Database["public"]["Enums"]["workspace_role"]
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          email: string
          full_name: string
          id: string
          role?: Database["public"]["Enums"]["workspace_role"]
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          email?: string
          full_name?: string
          id?: string
          role?: Database["public"]["Enums"]["workspace_role"]
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          created_at: string
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      analysis_finding_evidence: {
        Row: {
          analysis_id: string | null
          chunk_id: string | null
          document_id: string | null
          finding_id: string | null
          id: string | null
          page_number: number | null
          section: string | null
          section_heading: string | null
          snapshot: string | null
          version_id: string | null
          workspace_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "finding_evidence_chunk_id_version_id_workspace_id_fkey"
            columns: ["chunk_id", "version_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "document_chunks"
            referencedColumns: ["id", "version_id", "workspace_id"]
          },
          {
            foreignKeyName: "finding_evidence_finding_id_analysis_id_workspace_id_fkey"
            columns: ["finding_id", "analysis_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "analysis_findings"
            referencedColumns: ["id", "analysis_id", "workspace_id"]
          },
          {
            foreignKeyName: "finding_evidence_finding_id_analysis_id_workspace_id_fkey"
            columns: ["finding_id", "analysis_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "findings"
            referencedColumns: ["id", "analysis_id", "workspace_id"]
          },
          {
            foreignKeyName: "finding_evidence_version_id_document_id_workspace_id_fkey"
            columns: ["version_id", "document_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "document_versions"
            referencedColumns: ["id", "document_id", "workspace_id"]
          },
        ]
      }
      analysis_findings: {
        Row: {
          analysis_id: string | null
          created_at: string | null
          explanation: string | null
          id: string | null
          severity_current:
            | Database["public"]["Enums"]["finding_severity"]
            | null
          severity_original:
            | Database["public"]["Enums"]["finding_severity"]
            | null
          status: Database["public"]["Enums"]["finding_status"] | null
          type: Database["public"]["Enums"]["finding_type"] | null
          updated_at: string | null
          workspace_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "findings_analysis_id_workspace_id_fkey"
            columns: ["analysis_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "analyses"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "findings_analysis_id_workspace_id_fkey"
            columns: ["analysis_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "analysis_runs"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      analysis_runs: {
        Row: {
          created_at: string | null
          finished_at: string | null
          fixed_cost: number | null
          id: string | null
          initiator_full_name: string | null
          initiator_id: string | null
          public_error_code: string | null
          retry_of_analysis_id: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["analysis_job_status"] | null
          workspace_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "analyses_initiator_id_workspace_id_fkey"
            columns: ["initiator_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "analyses_retry_of_analysis_id_workspace_id_fkey"
            columns: ["retry_of_analysis_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "analyses"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "analyses_retry_of_analysis_id_workspace_id_fkey"
            columns: ["retry_of_analysis_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "analysis_runs"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "analyses_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      analysis_scope: {
        Row: {
          analysis_id: string | null
          document_category:
            | Database["public"]["Enums"]["document_category"]
            | null
          document_id: string | null
          document_name: string | null
          owner_full_name: string | null
          owner_id: string | null
          role: Database["public"]["Enums"]["analysis_scope_role"] | null
          version_id: string | null
          version_number: number | null
          workspace_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "analysis_documents_analysis_id_workspace_id_fkey"
            columns: ["analysis_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "analyses"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "analysis_documents_analysis_id_workspace_id_fkey"
            columns: ["analysis_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "analysis_runs"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "analysis_documents_version_id_document_id_workspace_id_fkey"
            columns: ["version_id", "document_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "document_versions"
            referencedColumns: ["id", "document_id", "workspace_id"]
          },
        ]
      }
      repository_documents: {
        Row: {
          active_version_id: string | null
          category: Database["public"]["Enums"]["document_category"] | null
          created_at: string | null
          id: string | null
          latest_analysis_status:
            | Database["public"]["Enums"]["analysis_status"]
            | null
          latest_processing_lease_expires_at: string | null
          latest_processing_queued: boolean | null
          latest_processing_started_at: string | null
          latest_processing_status:
            | Database["public"]["Enums"]["processing_status"]
            | null
          latest_upload_state:
            | Database["public"]["Enums"]["upload_state"]
            | null
          latest_version_id: string | null
          latest_version_number: number | null
          latest_version_status:
            | Database["public"]["Enums"]["version_status"]
            | null
          name: string | null
          owner_full_name: string | null
          owner_id: string | null
          owner_profile_id: string | null
          workspace_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "documents_active_version_fk"
            columns: ["active_version_id", "id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "document_versions"
            referencedColumns: ["id", "document_id", "workspace_id"]
          },
          {
            foreignKeyName: "documents_owner_id_workspace_id_fkey"
            columns: ["owner_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "documents_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      authorize_upload_resume_reference: {
        Args: {
          p_expected_sha256: string
          p_size_bytes: number
          p_user_id: string
          p_version_id: string
        }
        Returns: {
          authorized: boolean
        }[]
      }
      bind_legacy_upload_reference: {
        Args: {
          p_expected_sha256: string
          p_size_bytes: number
          p_user_id: string
          p_version_id: string
        }
        Returns: {
          attempt_id: string
          can_open: boolean
          can_recover: boolean
          can_resume: boolean
          upload_state: Database["public"]["Enums"]["upload_state"]
          version_id: string
        }[]
      }
      bootstrap_workspace: {
        Args: { full_name: string; workspace_name: string }
        Returns: string
      }
      claim_ingestion_job: {
        Args: never
        Returns: {
          operation_id: string
          started_at: string
          version_id: string
          workspace_id: string
        }[]
      }
      claim_upload_recovery: {
        Args: { p_user_id: string; p_version_id: string }
        Returns: {
          attempt_id: string
          canonical_mime_type: string
          canonical_path: string
          expected_sha256: string
          expected_size_bytes: number
          operation_id: string
          temporary_path: string
          upload_state: Database["public"]["Enums"]["upload_state"]
          version_id: string
          workspace_id: string
        }[]
      }
      claim_upload_verification: {
        Args: { p_attempt_id: string; p_user_id: string; p_version_id: string }
        Returns: {
          attempt_id: string
          canonical_mime_type: string
          canonical_path: string
          expected_sha256: string
          expected_size_bytes: number
          operation_id: string
          temporary_path: string
          upload_state: Database["public"]["Enums"]["upload_state"]
          version_id: string
          workspace_id: string
        }[]
      }
      enqueue_ingestion_job: {
        Args: {
          p_retry?: boolean
          p_version_id: string
          p_workspace_id: string
        }
        Returns: string
      }
      fail_ingestion_job: {
        Args: {
          p_operation_id: string
          p_retryable: boolean
          p_version_id: string
        }
        Returns: string
      }
      finish_processing: {
        Args: { p_chunks: Json; p_operation_id: string; p_version_id: string }
        Returns: undefined
      }
      finish_upload_recovery: {
        Args: {
          p_attempt_id: string
          p_object_absent: boolean
          p_operation_id: string
          p_user_id: string
          p_version_id: string
        }
        Returns: {
          attempt_id: string
          can_open: boolean
          can_recover: boolean
          can_resume: boolean
          upload_state: Database["public"]["Enums"]["upload_state"]
          version_id: string
        }[]
      }
      finish_upload_verification: {
        Args: {
          p_attempt_id: string
          p_operation_id: string
          p_result: Database["public"]["Enums"]["upload_state"]
          p_user_id: string
          p_version_id: string
        }
        Returns: {
          attempt_id: string
          can_open: boolean
          can_recover: boolean
          can_resume: boolean
          upload_state: Database["public"]["Enums"]["upload_state"]
          version_id: string
        }[]
      }
      get_confirmed_document_path: {
        Args: { p_user_id: string; p_version_id: string }
        Returns: string
      }
      get_document_upload_state: {
        Args: { p_user_id: string; p_version_id: string }
        Returns: {
          attempt_id: string
          can_open: boolean
          can_recover: boolean
          can_resume: boolean
          upload_state: Database["public"]["Enums"]["upload_state"]
          version_id: string
        }[]
      }
      get_upload_resume_target: {
        Args: { p_user_id: string; p_version_id: string }
        Returns: {
          attempt_id: string
          canonical_mime_type: string
          storage_path: string
          upload_state: Database["public"]["Enums"]["upload_state"]
          version_id: string
        }[]
      }
      heartbeat_ingestion_job: {
        Args: { p_operation_id: string; p_version_id: string }
        Returns: boolean
      }
      mark_upload_attempt_cleanup: {
        Args: {
          p_attempt_id: string
          p_object_absent: boolean
          p_version_id: string
        }
        Returns: boolean
      }
      reconcile_legacy_upload: {
        Args: {
          p_observation: string
          p_observed_sha256: string
          p_observed_size_bytes: number
          p_user_id: string
          p_version_id: string
        }
        Returns: {
          attempt_id: string
          outcome: string
          upload_state: Database["public"]["Enums"]["upload_state"]
          version_id: string
        }[]
      }
      reserve_document: {
        Args: {
          p_category: Database["public"]["Enums"]["document_category"]
          p_document_id: string
          p_extension: string
          p_name: string
          p_owner_id: string
          p_size_bytes: number
          p_version_id: string
        }
        Returns: string
      }
      reserve_document_upload: {
        Args: {
          p_category: Database["public"]["Enums"]["document_category"]
          p_expected_sha256: string
          p_extension: string
          p_idempotency_key: string
          p_name: string
          p_owner_id: string
          p_request_fingerprint: string
          p_size_bytes: number
          p_user_id: string
        }
        Returns: {
          attempt_id: string
          canonical_mime_type: string
          document_id: string
          storage_path: string
          upload_state: Database["public"]["Enums"]["upload_state"]
          version_id: string
        }[]
      }
    }
    Enums: {
      analysis_failure_code:
        | "RETRIEVAL_FAILED"
        | "ESTIMATE_STALE"
        | "PROVIDER_UNAVAILABLE"
        | "INVALID_PROVIDER_OUTPUT"
        | "PERSISTENCE_FAILED"
        | "TIMEOUT"
        | "ATTEMPTS_EXHAUSTED"
        | "INTERNAL_ERROR"
      analysis_job_status: "queued" | "processing" | "completed" | "failed"
      analysis_scope_role: "source" | "comparison"
      analysis_status: "pending_reanalysis" | "analyzed"
      credit_event_type: "Promotional" | "Reserved" | "Consumed" | "Released"
      document_category:
        | "SOP"
        | "Policy"
        | "Manual"
        | "QA Process"
        | "Security"
        | "Engineering Guideline"
        | "Other"
      finding_severity: "High" | "Medium" | "Low"
      finding_status: "pending_review"
      finding_type: "contradiction" | "obsolescence"
      notification_status: "pending" | "sent" | "failed"
      notification_type: "analysis_completed" | "analysis_failed"
      processing_status:
        | "uploaded"
        | "processing"
        | "ready"
        | "processing_failed"
      upload_cleanup_status: "pending" | "absent" | "failed"
      upload_control_mode: "paused" | "active"
      upload_hash_source: "client_declared" | "legacy_reconciled"
      upload_state:
        | "pending"
        | "verifying"
        | "rejected"
        | "recovering"
        | "confirmed"
      version_status: "active" | "historical" | "pending_approval" | "rejected"
      workspace_role: "Admin" | "QA Lead" | "Member"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      analysis_failure_code: [
        "RETRIEVAL_FAILED",
        "ESTIMATE_STALE",
        "PROVIDER_UNAVAILABLE",
        "INVALID_PROVIDER_OUTPUT",
        "PERSISTENCE_FAILED",
        "TIMEOUT",
        "ATTEMPTS_EXHAUSTED",
        "INTERNAL_ERROR",
      ],
      analysis_job_status: ["queued", "processing", "completed", "failed"],
      analysis_scope_role: ["source", "comparison"],
      analysis_status: ["pending_reanalysis", "analyzed"],
      credit_event_type: ["Promotional", "Reserved", "Consumed", "Released"],
      document_category: [
        "SOP",
        "Policy",
        "Manual",
        "QA Process",
        "Security",
        "Engineering Guideline",
        "Other",
      ],
      finding_severity: ["High", "Medium", "Low"],
      finding_status: ["pending_review"],
      finding_type: ["contradiction", "obsolescence"],
      notification_status: ["pending", "sent", "failed"],
      notification_type: ["analysis_completed", "analysis_failed"],
      processing_status: [
        "uploaded",
        "processing",
        "ready",
        "processing_failed",
      ],
      upload_cleanup_status: ["pending", "absent", "failed"],
      upload_control_mode: ["paused", "active"],
      upload_hash_source: ["client_declared", "legacy_reconciled"],
      upload_state: [
        "pending",
        "verifying",
        "rejected",
        "recovering",
        "confirmed",
      ],
      version_status: ["active", "historical", "pending_approval", "rejected"],
      workspace_role: ["Admin", "QA Lead", "Member"],
    },
  },
} as const

