import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
}

interface AttendancePayload {
  admin_user_id: string
  action: 'check-in' | 'check-out'
  check_in_time?: string
  check_out_time?: string
  check_in_selfie_url?: string
  check_out_selfie_url?: string
  check_in_location?: {
    latitude: number
    longitude: number
    address?: string
  }
  check_out_location?: {
    latitude: number
    longitude: number
    address?: string
  }
  notes?: string
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    })
  }

  try {
    if (req.method !== 'POST') {
      return new Response(
        JSON.stringify({ error: 'Method not allowed. Use POST.' }),
        {
          status: 405,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
        }
      )
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    const payload: AttendancePayload = await req.json()

    if (!payload.admin_user_id || !payload.action) {
      return new Response(
        JSON.stringify({
          error: 'Missing required fields',
          required: ['admin_user_id', 'action'],
        }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
        }
      )
    }

    if (!['check-in', 'check-out'].includes(payload.action)) {
      return new Response(
        JSON.stringify({
          error: 'Invalid action',
          valid_values: ['check-in', 'check-out'],
        }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
        }
      )
    }

    const { data: adminUser, error: adminUserError } = await supabase
      .from('admin_users')
      .select('id, full_name')
      .eq('id', payload.admin_user_id)
      .maybeSingle()

    if (!adminUser || adminUserError) {
      return new Response(
        JSON.stringify({
          error: 'Invalid admin_user_id',
          message: 'User ID not found in admin_users table',
        }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
        }
      )
    }

    const now = new Date()
    const kolkataTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }))
    const dateString = kolkataTime.toISOString().split('T')[0]

    if (payload.action === 'check-in') {
      const { data: existingAttendance } = await supabase
        .from('attendance')
        .select('id, check_in_time')
        .eq('admin_user_id', payload.admin_user_id)
        .eq('date', dateString)
        .maybeSingle()

      if (existingAttendance) {
        return new Response(
          JSON.stringify({
            error: 'Already checked in',
            message: 'Attendance record already exists for today',
            existing_check_in: existingAttendance.check_in_time,
          }),
          {
            status: 400,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json',
            },
          }
        )
      }

      const checkInTime = payload.check_in_time || now.toISOString()

      const insertData: any = {
        admin_user_id: payload.admin_user_id,
        date: dateString,
        check_in_time: checkInTime,
        check_in_selfie_url: payload.check_in_selfie_url || null,
        check_in_location: payload.check_in_location ? JSON.stringify(payload.check_in_location) : null,
        notes: payload.notes || null,
        status: 'Present',
      }

      const { data: newAttendance, error: insertError } = await supabase
        .from('attendance')
        .insert(insertData)
        .select()
        .single()

      if (insertError) {
        console.error('Error inserting attendance:', insertError)
        return new Response(
          JSON.stringify({ error: 'Failed to mark check-in', details: insertError.message }),
          {
            status: 500,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json',
            },
          }
        )
      }

      return new Response(
        JSON.stringify({
          success: true,
          action: 'check-in',
          message: `Check-in recorded successfully for ${adminUser.full_name}`,
          data: newAttendance,
        }),
        {
          status: 201,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
        }
      )
    } else if (payload.action === 'check-out') {
      const { data: existingAttendance, error: fetchError } = await supabase
        .from('attendance')
        .select('*')
        .eq('admin_user_id', payload.admin_user_id)
        .eq('date', dateString)
        .maybeSingle()

      if (!existingAttendance || fetchError) {
        return new Response(
          JSON.stringify({
            error: 'No check-in found',
            message: 'Cannot check-out without checking in first',
          }),
          {
            status: 400,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json',
            },
          }
        )
      }

      if (existingAttendance.check_out_time) {
        return new Response(
          JSON.stringify({
            error: 'Already checked out',
            message: 'Attendance record already has a check-out time',
            existing_check_out: existingAttendance.check_out_time,
          }),
          {
            status: 400,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json',
            },
          }
        )
      }

      const checkOutTime = payload.check_out_time || now.toISOString()

      const checkInDate = new Date(existingAttendance.check_in_time)
      const checkOutDate = new Date(checkOutTime)
      const actualHours = (checkOutDate.getTime() - checkInDate.getTime()) / (1000 * 60 * 60)

      const updateData: any = {
        check_out_time: checkOutTime,
        check_out_selfie_url: payload.check_out_selfie_url || null,
        check_out_location: payload.check_out_location ? JSON.stringify(payload.check_out_location) : null,
        actual_working_hours: Math.round(actualHours * 100) / 100,
        notes: payload.notes || existingAttendance.notes,
      }

      const { data: updatedAttendance, error: updateError } = await supabase
        .from('attendance')
        .update(updateData)
        .eq('id', existingAttendance.id)
        .select()
        .single()

      if (updateError) {
        console.error('Error updating attendance:', updateError)
        return new Response(
          JSON.stringify({ error: 'Failed to mark check-out', details: updateError.message }),
          {
            status: 500,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json',
            },
          }
        )
      }

      return new Response(
        JSON.stringify({
          success: true,
          action: 'check-out',
          message: `Check-out recorded successfully for ${adminUser.full_name}`,
          data: updatedAttendance,
          working_hours: actualHours.toFixed(2),
        }),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
        }
      )
    }
  } catch (error) {
    console.error('Unexpected error:', error)
    return new Response(
      JSON.stringify({
        error: 'Internal server error',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      }
    )
  }
})
