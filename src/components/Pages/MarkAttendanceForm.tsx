import React, { useState, useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { Clock, Camera, MapPin, CheckCircle, User, X, LogIn, LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { supabase } from '@/lib/supabase'
import { format } from 'date-fns'
import { useSearchParams, useNavigate } from 'react-router-dom'

interface Location {
  lat: number
  lng: number
  address: string
}

interface AdminUser {
  id: string
  full_name: string
  email: string
  phone?: string
}

export function MarkAttendanceForm() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const adminUserId = searchParams.get('admin_user_id')
  const action = searchParams.get('action') as 'check-in' | 'check-out' | null

  const [user, setUser] = useState<AdminUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [selfieDataUrl, setSelfieDataUrl] = useState<string | null>(null)
  const [isCameraActive, setIsCameraActive] = useState(false)
  const [location, setLocation] = useState<Location | null>(null)
  const [dateTime, setDateTime] = useState<string>(new Date().toISOString())
  const [notes, setNotes] = useState('')
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [existingAttendance, setExistingAttendance] = useState<any>(null)

  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)

  useEffect(() => {
    if (!adminUserId || !action) {
      setError('Missing required parameters: admin_user_id and action')
      setLoading(false)
      return
    }

    if (!['check-in', 'check-out'].includes(action)) {
      setError('Invalid action. Must be check-in or check-out')
      setLoading(false)
      return
    }

    fetchUser()
    captureLocation()
    if (action === 'check-in') {
      startCamera()
    } else {
      fetchExistingAttendance()
    }

    const interval = setInterval(() => {
      setDateTime(new Date().toISOString())
    }, 1000)

    return () => {
      clearInterval(interval)
      stopCamera()
    }
  }, [adminUserId, action])

  const fetchUser = async () => {
    try {
      setLoading(true)
      const { data, error } = await supabase
        .from('admin_users')
        .select('id, full_name, email, phone')
        .eq('id', adminUserId)
        .maybeSingle()

      if (error) {
        console.error('Supabase error:', error)
        setError(`Error: ${error.message}`)
        return
      }

      if (!data) {
        setError('User not found')
        return
      }

      setUser(data)
    } catch (err) {
      console.error('Error fetching user:', err)
      setError('Failed to load user information')
    } finally {
      setLoading(false)
    }
  }

  const fetchExistingAttendance = async () => {
    try {
      const today = format(new Date(), 'yyyy-MM-dd')
      const { data } = await supabase
        .from('attendance')
        .select('*')
        .eq('admin_user_id', adminUserId)
        .eq('date', today)
        .maybeSingle()

      if (data) {
        setExistingAttendance(data)
        startCamera()
      } else {
        setError('No check-in found for today. Please check-in first.')
      }
    } catch (err) {
      console.error('Error fetching attendance:', err)
    }
  }

  const captureLocation = async () => {
    try {
      const loc = await getCurrentLocation()
      setLocation(loc)
    } catch (err) {
      console.error('Error getting location:', err)
      setError('Unable to capture location. Please enable location services.')
    }
  }

  const getCurrentLocation = (): Promise<Location> => {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Geolocation not supported'))
        return
      }

      navigator.geolocation.getCurrentPosition(
        async (position) => {
          const lat = position.coords.latitude
          const lng = position.coords.longitude

          try {
            const response = await fetch(
              `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`
            )
            const data = await response.json()
            const address = data.display_name || `${lat}, ${lng}`

            resolve({ lat, lng, address })
          } catch {
            resolve({ lat, lng, address: `${lat}, ${lng}` })
          }
        },
        (error) => {
          reject(error)
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 0
        }
      )
    })
  }

  const startCamera = async () => {
    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop())
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      })

      streamRef.current = stream

      if (videoRef.current) {
        videoRef.current.srcObject = stream
        videoRef.current.onloadedmetadata = () => {
          videoRef.current?.play().catch(err => {
            console.error('Error playing video:', err)
          })
        }
      }

      setIsCameraActive(true)
    } catch (err) {
      console.error('Error accessing camera:', err)
      setError('Failed to access camera. Please allow camera permissions.')
    }
  }

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop())
      streamRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
    setIsCameraActive(false)
  }

  const captureSelfie = () => {
    if (videoRef.current && canvasRef.current) {
      const canvas = canvasRef.current
      canvas.width = videoRef.current.videoWidth
      canvas.height = videoRef.current.videoHeight

      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.drawImage(videoRef.current, 0, 0)
        const dataUrl = canvas.toDataURL('image/jpeg', 0.8)
        setSelfieDataUrl(dataUrl)
        stopCamera()
      }
    }
  }

  const retakeSelfie = () => {
    setSelfieDataUrl(null)
    startCamera()
  }

  const uploadToGHL = async (dataUrl: string): Promise<string> => {
    try {
      const { data: integration } = await supabase
        .from('integrations')
        .select('config')
        .eq('integration_type', 'ghl_api')
        .maybeSingle()

      if (!integration?.config?.accessToken) {
        console.log('No GHL integration configured')
        return dataUrl
      }

      const accessToken = integration.config.accessToken
      const locationId = integration.config.locationId || 'iDIRFjdZBWH7SqBzTowc'

      const triggerEvent = action === 'check-in' ? 'ATTENDANCE_CHECKIN' : 'ATTENDANCE_CHECKOUT'
      const { data: folderAssignment } = await supabase
        .from('media_folder_assignments')
        .select('media_folder_id, media_folders!inner(id, ghl_folder_id, folder_name)')
        .eq('trigger_event', triggerEvent)
        .eq('module', 'Attendance')
        .maybeSingle()

      const ghlFolderId = folderAssignment?.media_folders?.ghl_folder_id
      const folderId = folderAssignment?.media_folders?.id

      if (!ghlFolderId) {
        console.log('No GHL folder configured')
        return dataUrl
      }

      const response = await fetch(dataUrl)
      const blob = await response.blob()

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const fileName = `attendance-${action}-${adminUserId}-${timestamp}.jpg`
      const file = new File([blob], fileName, { type: 'image/jpeg' })

      const formData = new FormData()
      formData.append('file', file)
      formData.append('name', fileName)
      formData.append('parentId', ghlFolderId)

      const uploadResponse = await fetch('https://services.leadconnectorhq.com/medias/upload-file', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Version': '2021-07-28',
          'Authorization': `Bearer ${accessToken.trim()}`
        },
        body: formData
      })

      if (uploadResponse.ok) {
        const ghlFile = await uploadResponse.json()
        const fileUrl = ghlFile.url || ghlFile.fileUrl || dataUrl

        await supabase.from('media_files').insert({
          file_name: fileName,
          file_url: fileUrl,
          file_type: 'image/jpeg',
          file_size: file.size,
          ghl_file_id: ghlFile._id || ghlFile.id,
          folder_id: folderId || null,
          location_id: locationId,
          thumbnail_url: ghlFile.thumbnailUrl || null,
          uploaded_by: adminUserId
        })

        return fileUrl
      }

      return dataUrl
    } catch (err) {
      console.warn('Failed to upload to GHL:', err)
      return dataUrl
    }
  }

  const handleSubmit = async () => {
    if (!selfieDataUrl) {
      setError('Please capture a selfie')
      return
    }

    if (!location) {
      setError('Location not captured. Please try again.')
      return
    }

    try {
      setSubmitting(true)
      setError(null)

      const selfieUrl = await uploadToGHL(selfieDataUrl)

      if (action === 'check-in') {
        const { error: insertError } = await supabase
          .from('attendance')
          .insert({
            admin_user_id: adminUserId,
            date: format(new Date(), 'yyyy-MM-dd'),
            check_in_time: dateTime,
            check_in_selfie_url: selfieUrl,
            check_in_location: location,
            status: 'Present',
            notes: notes || null
          })

        if (insertError) {
          throw insertError
        }
      } else if (action === 'check-out' && existingAttendance) {
        const checkInDate = new Date(existingAttendance.check_in_time)
        const checkOutDate = new Date(dateTime)
        const actualHours = (checkOutDate.getTime() - checkInDate.getTime()) / (1000 * 60 * 60)

        const { error: updateError } = await supabase
          .from('attendance')
          .update({
            check_out_time: dateTime,
            check_out_selfie_url: selfieUrl,
            check_out_location: location,
            actual_working_hours: Math.round(actualHours * 100) / 100,
            notes: notes || existingAttendance.notes
          })
          .eq('id', existingAttendance.id)

        if (updateError) {
          throw updateError
        }
      }

      setSuccess(true)
      setTimeout(() => {
        window.close()
      }, 3000)
    } catch (err: any) {
      console.error('Error submitting attendance:', err)
      setError(err.message || 'Failed to submit attendance')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100">
        <Card className="w-full max-w-md">
          <CardContent className="p-8 text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-slate-900 mx-auto mb-4"></div>
            <p className="text-slate-600">Loading...</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (error && !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100 p-4">
        <Card className="w-full max-w-md">
          <CardContent className="p-8 text-center">
            <div className="bg-red-100 text-red-800 rounded-full p-4 w-16 h-16 flex items-center justify-center mx-auto mb-4">
              <X className="w-8 h-8" />
            </div>
            <h2 className="text-xl font-semibold text-slate-900 mb-2">Error</h2>
            <p className="text-slate-600 mb-4">{error}</p>
            <Button onClick={() => window.close()} variant="outline">
              Close
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-green-50 to-emerald-100 p-4">
        <Card className="w-full max-w-md">
          <CardContent className="p-8 text-center">
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: 'spring', stiffness: 200, damping: 20 }}
              className="bg-green-500 text-white rounded-full p-4 w-16 h-16 flex items-center justify-center mx-auto mb-4"
            >
              <CheckCircle className="w-8 h-8" />
            </motion.div>
            <h2 className="text-2xl font-bold text-slate-900 mb-2">Success!</h2>
            <p className="text-slate-600 mb-1">
              {action === 'check-in' ? 'Check-in' : 'Check-out'} recorded successfully
            </p>
            <p className="text-sm text-slate-500">This window will close automatically...</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 p-4">
      <div className="max-w-2xl mx-auto py-8">
        <Card>
          <CardHeader className="border-b border-slate-200">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {action === 'check-in' ? (
                  <div className="bg-green-100 text-green-700 rounded-full p-2">
                    <LogIn className="w-6 h-6" />
                  </div>
                ) : (
                  <div className="bg-orange-100 text-orange-700 rounded-full p-2">
                    <LogOut className="w-6 h-6" />
                  </div>
                )}
                <div>
                  <CardTitle className="text-2xl">
                    {action === 'check-in' ? 'Check-In' : 'Check-Out'}
                  </CardTitle>
                  <p className="text-sm text-slate-500 mt-1">Mark your attendance</p>
                </div>
              </div>
            </div>
          </CardHeader>

          <CardContent className="p-6 space-y-6">
            {error && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-4"
              >
                {error}
              </motion.div>
            )}

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  <User className="w-4 h-4 inline mr-2" />
                  Employee Name
                </label>
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-slate-900 font-medium">
                  {user?.full_name}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  <Clock className="w-4 h-4 inline mr-2" />
                  Date & Time
                </label>
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-slate-900">
                  {format(new Date(dateTime), 'PPP p')}
                </div>
              </div>

              {location && (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">
                    <MapPin className="w-4 h-4 inline mr-2" />
                    Location
                  </label>
                  <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm text-slate-700">
                    <p className="font-medium mb-1">
                      {location.lat.toFixed(6)}, {location.lng.toFixed(6)}
                    </p>
                    <p className="text-slate-500">{location.address}</p>
                  </div>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  <Camera className="w-4 h-4 inline mr-2" />
                  Selfie
                </label>

                {!selfieDataUrl ? (
                  <div className="space-y-3">
                    <div className="relative bg-slate-900 rounded-lg overflow-hidden aspect-video">
                      <video
                        ref={videoRef}
                        autoPlay
                        playsInline
                        muted
                        className="w-full h-full object-cover"
                      />
                      {!isCameraActive && (
                        <div className="absolute inset-0 flex items-center justify-center text-white">
                          <div className="text-center">
                            <Camera className="w-12 h-12 mx-auto mb-2 opacity-50" />
                            <p>Camera loading...</p>
                          </div>
                        </div>
                      )}
                    </div>
                    <Button
                      onClick={captureSelfie}
                      disabled={!isCameraActive}
                      className="w-full"
                      size="lg"
                    >
                      <Camera className="w-4 h-4 mr-2" />
                      Capture Selfie
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="relative rounded-lg overflow-hidden border border-slate-200">
                      <img
                        src={selfieDataUrl}
                        alt="Captured selfie"
                        className="w-full h-auto"
                      />
                    </div>
                    <Button
                      onClick={retakeSelfie}
                      variant="outline"
                      className="w-full"
                      size="lg"
                    >
                      <Camera className="w-4 h-4 mr-2" />
                      Retake Selfie
                    </Button>
                  </div>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Notes (Optional)
                </label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Add any notes..."
                  rows={3}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-400"
                />
              </div>
            </div>

            <div className="flex gap-3 pt-4">
              <Button
                onClick={handleSubmit}
                disabled={submitting || !selfieDataUrl || !location}
                className="flex-1"
                size="lg"
              >
                {submitting ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2" />
                    Submitting...
                  </>
                ) : (
                  <>
                    <CheckCircle className="w-4 h-4 mr-2" />
                    Submit {action === 'check-in' ? 'Check-In' : 'Check-Out'}
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <canvas ref={canvasRef} style={{ display: 'none' }} />
    </div>
  )
}
