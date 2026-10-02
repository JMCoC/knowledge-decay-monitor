export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
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
      document_versions: {
        Row: {
          analysis_status: Database["public"]["Enums"]["analysis_status"]
          created_at: string
          document_id: string
          id: string
          processing_status: Database["public"]["Enums"]["processing_status"]
          size_bytes: number | null
          storage_path: string
          updated_at: string
          version_number: number
          version_status: Database["public"]["Enums"]["version_status"] | null
          workspace_id: string
        }
        Insert: {
          analysis_status?: Database["public"]["Enums"]["analysis_status"]
          created_at?: string
          document_id: string
          id?: string
          processing_status?: Database["public"]["Enums"]["processing_status"]
          size_bytes?: number | null
          storage_path: string
          updated_at?: string
          version_number: number
          version_status?: Database["public"]["Enums"]["version_status"] | null
          workspace_id?: string
        }
        Update: {
          analysis_status?: Database["public"]["Enums"]["analysis_status"]
          created_at?: string
          document_id?: string
          id?: string
          processing_status?: Database["public"]["Enums"]["processing_status"]
          size_bytes?: number | null
          storage_path?: string
          updated_at?: string
          version_number?: number
          version_status?: Database["public"]["Enums"]["version_status"] | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_versions_document_id_workspace_id_fkey"
            columns: ["document_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "documents"
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
      [_ in never]: never
    }
    Functions: {
      bootstrap_workspace: {
        Args: { full_name: string; workspace_name: string }
        Returns: string
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
    }
    Enums: {
      analysis_status: "pending_reanalysis" | "analyzed"
      document_category:
        | "SOP"
        | "Policy"
        | "Manual"
        | "QA Process"
        | "Security"
        | "Engineering Guideline"
        | "Other"
      processing_status:
        | "uploaded"
        | "processing"
        | "ready"
        | "processing_failed"
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
  public: {
    Enums: {
      analysis_status: ["pending_reanalysis", "analyzed"],
      document_category: [
        "SOP",
        "Policy",
        "Manual",
        "QA Process",
        "Security",
        "Engineering Guideline",
        "Other",
      ],
      processing_status: [
        "uploaded",
        "processing",
        "ready",
        "processing_failed",
      ],
      version_status: ["active", "historical", "pending_approval", "rejected"],
      workspace_role: ["Admin", "QA Lead", "Member"],
    },
  },
} as const

