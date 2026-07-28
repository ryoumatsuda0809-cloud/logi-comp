export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      compliance_logs: {
        Row: {
          client_name: string | null
          client_organization_id: string | null
          created_at: string
          driver_id: string | null
          event_type: Database["public"]["Enums"]["compliance_event"]
          id: string
          is_manual: boolean | null
          latitude: number | null
          location_check: boolean
          location_name: string | null
          longitude: number | null
          order_id: string
          organization_id: string
          recorded_at: string
          system_note: string | null
          ticket_number: string | null
          user_id: string | null
          waiting_minutes: number | null
        }
        Insert: {
          client_name?: string | null
          client_organization_id?: string | null
          created_at?: string
          driver_id?: string | null
          event_type: Database["public"]["Enums"]["compliance_event"]
          id?: string
          is_manual?: boolean | null
          latitude?: number | null
          location_check?: boolean
          location_name?: string | null
          longitude?: number | null
          order_id: string
          organization_id?: string
          recorded_at?: string
          system_note?: string | null
          ticket_number?: string | null
          user_id?: string | null
          waiting_minutes?: number | null
        }
        Update: {
          client_name?: string | null
          client_organization_id?: string | null
          created_at?: string
          driver_id?: string | null
          event_type?: Database["public"]["Enums"]["compliance_event"]
          id?: string
          is_manual?: boolean | null
          latitude?: number | null
          location_check?: boolean
          location_name?: string | null
          longitude?: number | null
          order_id?: string
          organization_id?: string
          recorded_at?: string
          system_note?: string | null
          ticket_number?: string | null
          user_id?: string | null
          waiting_minutes?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "compliance_logs_client_organization_id_fkey"
            columns: ["client_organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compliance_logs_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "transport_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compliance_logs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      daily_reports: {
        Row: {
          created_at: string | null
          id: string
          report_text: string
          shipper_name: string | null
          summary: string | null
          uncompensated_work: boolean | null
          user_id: string
          waiting_minutes: number | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          report_text: string
          shipper_name?: string | null
          summary?: string | null
          uncompensated_work?: boolean | null
          user_id: string
          waiting_minutes?: number | null
        }
        Update: {
          created_at?: string | null
          id?: string
          report_text?: string
          shipper_name?: string | null
          summary?: string | null
          uncompensated_work?: boolean | null
          user_id?: string
          waiting_minutes?: number | null
        }
        Relationships: []
      }
      facilities: {
        Row: {
          address: string | null
          client_name: string
          created_at: string
          id: string
          lat: number
          lng: number
          name: string
          radius: number
        }
        Insert: {
          address?: string | null
          client_name: string
          created_at?: string
          id?: string
          lat: number
          lng: number
          name: string
          radius?: number
        }
        Update: {
          address?: string | null
          client_name?: string
          created_at?: string
          id?: string
          lat?: number
          lng?: number
          name?: string
          radius?: number
        }
        Relationships: []
      }
      organization_details: {
        Row: {
          address_line1: string | null
          address_line2: string | null
          city: string | null
          created_at: string | null
          description: string | null
          id: string
          industry_type: string | null
          organization_id: string
          phone_number: string | null
          postal_code: string | null
          prefecture: string | null
          updated_at: string | null
          website_url: string | null
        }
        Insert: {
          address_line1?: string | null
          address_line2?: string | null
          city?: string | null
          created_at?: string | null
          description?: string | null
          id?: string
          industry_type?: string | null
          organization_id: string
          phone_number?: string | null
          postal_code?: string | null
          prefecture?: string | null
          updated_at?: string | null
          website_url?: string | null
        }
        Update: {
          address_line1?: string | null
          address_line2?: string | null
          city?: string | null
          created_at?: string | null
          description?: string | null
          id?: string
          industry_type?: string | null
          organization_id?: string
          phone_number?: string | null
          postal_code?: string | null
          prefecture?: string | null
          updated_at?: string | null
          website_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "organization_details_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_financials: {
        Row: {
          capital_amount: number | null
          created_at: string | null
          employee_count: number | null
          id: string
          is_regulated: boolean | null
          organization_id: string
          updated_at: string | null
        }
        Insert: {
          capital_amount?: number | null
          created_at?: string | null
          employee_count?: number | null
          id?: string
          is_regulated?: boolean | null
          organization_id: string
          updated_at?: string | null
        }
        Update: {
          capital_amount?: number | null
          created_at?: string | null
          employee_count?: number | null
          id?: string
          is_regulated?: boolean | null
          organization_id?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "organization_financials_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_invite_codes: {
        Row: {
          code: string
          created_at: string
          id: string
          is_active: boolean
          organization_id: string
        }
        Insert: {
          code: string
          created_at?: string
          id?: string
          is_active?: boolean
          organization_id: string
        }
        Update: {
          code?: string
          created_at?: string
          id?: string
          is_active?: boolean
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_invite_codes_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_members: {
        Row: {
          created_at: string | null
          id: string
          organization_id: string | null
          role: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          organization_id?: string | null
          role?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          organization_id?: string | null
          role?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "organization_members_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string
          id: string
          latitude: number | null
          longitude: number | null
          name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          latitude?: number | null
          longitude?: number | null
          name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          latitude?: number | null
          longitude?: number | null
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          id: string
          organization_id: string | null
          role: string | null
          updated_at: string
          user_id: string
          vehicle_class: string | null
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id?: string
          organization_id?: string | null
          role?: string | null
          updated_at?: string
          user_id: string
          vehicle_class?: string | null
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
          organization_id?: string | null
          role?: string | null
          updated_at?: string
          user_id?: string
          vehicle_class?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "profiles_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      saved_locations: {
        Row: {
          address: string
          id: string
          last_used_at: string
          location_type: string
          usage_count: number
          user_id: string
        }
        Insert: {
          address: string
          id?: string
          last_used_at?: string
          location_type: string
          usage_count?: number
          user_id?: string
        }
        Update: {
          address?: string
          id?: string
          last_used_at?: string
          location_type?: string
          usage_count?: number
          user_id?: string
        }
        Relationships: []
      }
      submitted_reports: {
        Row: {
          estimated_wait_cost: number
          formal_report: string | null
          has_discrepancy: boolean
          id: string
          is_edited: boolean
          organization_id: string | null
          original_ai_output: string | null
          report_date: string
          submitted_at: string
          timeline_snapshot: Json
          total_wait_minutes: number
          user_id: string
          vehicle_class: string
        }
        Insert: {
          estimated_wait_cost?: number
          formal_report?: string | null
          has_discrepancy?: boolean
          id?: string
          is_edited?: boolean
          organization_id?: string | null
          original_ai_output?: string | null
          report_date?: string
          submitted_at?: string
          timeline_snapshot?: Json
          total_wait_minutes?: number
          user_id?: string
          vehicle_class?: string
        }
        Update: {
          estimated_wait_cost?: number
          formal_report?: string | null
          has_discrepancy?: boolean
          id?: string
          is_edited?: boolean
          organization_id?: string | null
          original_ai_output?: string | null
          report_date?: string
          submitted_at?: string
          timeline_snapshot?: Json
          total_wait_minutes?: number
          user_id?: string
          vehicle_class?: string
        }
        Relationships: []
      }
      transport_orders: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          content_json: Json
          created_at: string
          created_by: string | null
          delivery_due_date: string | null
          id: string
          organization_id: string
          status: Database["public"]["Enums"]["order_status"]
          temperature_zone: string
          updated_at: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          content_json?: Json
          created_at?: string
          created_by?: string | null
          delivery_due_date?: string | null
          id?: string
          organization_id: string
          status?: Database["public"]["Enums"]["order_status"]
          temperature_zone?: string
          updated_at?: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          content_json?: Json
          created_at?: string
          created_by?: string | null
          delivery_due_date?: string | null
          id?: string
          organization_id?: string
          status?: Database["public"]["Enums"]["order_status"]
          temperature_zone?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "transport_orders_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          organization_id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          organization_id: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          organization_id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_roles_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      wait_logs: {
        Row: {
          arrival_time: string
          called_time: string | null
          created_at: string
          facility_id: string
          id: string
          latitude: number | null
          longitude: number | null
          status: string | null
          ticket_number: number
          user_id: string
          waiting_minutes: number | null
          work_end_time: string | null
          work_start_time: string | null
        }
        Insert: {
          arrival_time?: string
          called_time?: string | null
          created_at?: string
          facility_id: string
          id?: string
          latitude?: number | null
          longitude?: number | null
          status?: string | null
          ticket_number: number
          user_id: string
          waiting_minutes?: number | null
          work_end_time?: string | null
          work_start_time?: string | null
        }
        Update: {
          arrival_time?: string
          called_time?: string | null
          created_at?: string
          facility_id?: string
          id?: string
          latitude?: number | null
          longitude?: number | null
          status?: string | null
          ticket_number?: number
          user_id?: string
          waiting_minutes?: number | null
          work_end_time?: string | null
          work_start_time?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "wait_logs_facility_id_fkey"
            columns: ["facility_id"]
            isOneToOne: false
            referencedRelation: "facilities"
            referencedColumns: ["id"]
          },
        ]
      }
      waiting_evidence: {
        Row: {
          completed_at: string | null
          created_at: string
          evidence_type: Database["public"]["Enums"]["evidence_type"]
          fishery_data: Json | null
          id: string
          is_signed: boolean
          latitude: number
          longitude: number
          note: string | null
          organization_id: string | null
          photo_url: string | null
          recorded_at: string
          signed_at: string | null
          user_id: string
          wait_log_id: string | null
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          evidence_type: Database["public"]["Enums"]["evidence_type"]
          fishery_data?: Json | null
          id?: string
          is_signed?: boolean
          latitude: number
          longitude: number
          note?: string | null
          organization_id?: string | null
          photo_url?: string | null
          recorded_at?: string
          signed_at?: string | null
          user_id: string
          wait_log_id?: string | null
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          evidence_type?: Database["public"]["Enums"]["evidence_type"]
          fishery_data?: Json | null
          id?: string
          is_signed?: boolean
          latitude?: number
          longitude?: number
          note?: string | null
          organization_id?: string | null
          photo_url?: string | null
          recorded_at?: string
          signed_at?: string | null
          user_id?: string
          wait_log_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "waiting_evidence_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "waiting_evidence_wait_log_id_fkey"
            columns: ["wait_log_id"]
            isOneToOne: false
            referencedRelation: "wait_logs"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      monthly_wait_risk_reports: {
        Row: {
          client_organization_name: string | null
          estimated_loss_jpy: number | null
          gmen_risk_level: string | null
          location_name: string | null
          report_month: string | null
          total_visits: number | null
          total_wait_minutes: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      advance_wait_status: {
        Args: { p_log_id: string; p_new_status: string }
        Returns: undefined
      }
      cancel_ticket: {
        Args: { p_log_id: string }
        Returns: {
          cancelled_at: string
          log_id: string
        }[]
      }
      complete_ticket: {
        Args: {
          p_fishery_data?: Json
          p_latitude: number
          p_log_id: string
          p_longitude: number
        }
        Returns: {
          completed_at: string
          log_id: string
          waiting_minutes: number
        }[]
      }
      create_invite_code: { Args: { _org_id: string }; Returns: string }
      create_organization_with_admin: {
        Args: { org_name: string }
        Returns: string
      }
      deactivate_invite_code: { Args: { _code_id: string }; Returns: undefined }
      force_join_organization_by_invite_code: {
        Args: { target_invite_code: string }
        Returns: undefined
      }
      generate_invite_code: { Args: never; Returns: string }
      generate_ticket_number: {
        Args: {
          _facility_name: string
          _lat?: number
          _lng?: number
          _order_id: string
          _organization_id: string
          _target_client_names: string[]
        }
        Returns: string
      }
      get_nearest_facility: {
        Args: { user_lat: number; user_lng: number }
        Returns: {
          client_name: string
          distance_m: number
          id: string
          lat: number
          lng: number
          name: string
          radius: number
        }[]
      }
      get_order_geofence: {
        Args: { _order_id: string }
        Returns: {
          lat: number
          lon: number
        }[]
      }
      get_user_org_id: { Args: { _user_id: string }; Returns: string }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      has_role_in_org: {
        Args: {
          _org_id: string
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_member_of_org: {
        Args: { _org_id: string; _user_id: string }
        Returns: boolean
      }
      issue_ticket: {
        Args: {
          p_facility_id: string
          p_latitude: number
          p_longitude: number
        }
        Returns: {
          log_id: string
          new_arrival_time: string
          new_ticket_number: number
        }[]
      }
      join_organization_by_invite_code: {
        Args: { _code: string }
        Returns: string
      }
      verify_company_name: {
        Args: { _input: string }
        Returns: {
          matched_address: string
          matched_client_name: string
          matched_facility_id: string
        }[]
      }
    }
    Enums: {
      app_role: "admin" | "driver" | "user" | "receiver"
      compliance_event:
        | "arrival"
        | "waiting_start"
        | "loading_start"
        | "departure"
      evidence_type: "arrival" | "departure" | "gps_checkpoint"
      order_status: "draft" | "approved" | "delivered"
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
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
      app_role: ["admin", "driver", "user", "receiver"],
      compliance_event: [
        "arrival",
        "waiting_start",
        "loading_start",
        "departure",
      ],
      evidence_type: ["arrival", "departure", "gps_checkpoint"],
      order_status: ["draft", "approved", "delivered"],
    },
  },
} as const
