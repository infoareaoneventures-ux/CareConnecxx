import React, { useEffect, useRef, useState } from 'react';
import { Video, VideoOff, Mic, MicOff, PhoneOff, Loader2, AlertCircle } from 'lucide-react';
import { Button } from './ui/Button';
import { VideoInterview } from '../types';
import { videoService } from '../services/videoService';

let TwilioVideo: any;

interface VideoInterviewRoomProps {
    interview: VideoInterview;
    userId: string;
    userName: string;
    onEnd: () => void;
    onShowToast: (message: string, type: 'success' | 'error' | 'info') => void;
}

export const VideoInterviewRoom: React.FC<VideoInterviewRoomProps> = ({
    interview,
    userId,
    userName,
    onEnd,
    onShowToast,
}) => {
    const [room, setRoom] = useState<any>(null);
    const [isConnecting, setIsConnecting] = useState(true);
    const [isVideoEnabled, setIsVideoEnabled] = useState(true);
    const [isAudioEnabled, setIsAudioEnabled] = useState(true);
    const [participants, setParticipants] = useState<any[]>([]);
    const [error, setError] = useState<string | null>(null);

    const localVideoRef = useRef<HTMLVideoElement>(null);
    const remoteVideoRef = useRef<HTMLVideoElement>(null);

    useEffect(() => {
        let cancelled = false;
        import('twilio-video')
            .then((mod) => {
                if (!cancelled) {
                    TwilioVideo = mod;
                    connectToRoom();
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setError('Video SDK not loaded. Please refresh the page.');
                    setIsConnecting(false);
                }
            });

        return () => {
            cancelled = true;
            if (room) {
                room.disconnect();
            }
        };
    }, []);

    const connectToRoom = async () => {
        try {
            setIsConnecting(true);

            // Get access token from our service
            const { roomName, token } = await videoService.joinInterview(
                interview.id,
                userId,
                userName
            );

            // For demo purposes, we'll create a mock connection
            // In production, this would use the actual Twilio token
            if (token.startsWith('TWILIO_TOKEN_')) {
                // Mock mode for demo
                setIsConnecting(false);
                onShowToast('Demo mode: Video SDK will be activated once Twilio credentials are configured', 'info');

                // Simulate local video
                if (localVideoRef.current && navigator.mediaDevices) {
                    try {
                        const stream = await navigator.mediaDevices.getUserMedia({
                            video: true,
                            audio: true
                        });
                        localVideoRef.current.srcObject = stream;
                    } catch (e) {
                        console.error('Error accessing media devices:', e);
                    }
                }
                return;
            }

            // Real Twilio connection (when credentials are configured)
            const connectedRoom = await TwilioVideo.connect(token, {
                name: roomName,
                audio: true,
                video: { width: 640 },
            });

            setRoom(connectedRoom);
            setIsConnecting(false);

            // Attach local video
            connectedRoom.localParticipant.videoTracks.forEach((publication: any) => {
                if (localVideoRef.current) {
                    const track = publication.track;
                    localVideoRef.current.appendChild(track.attach());
                }
            });

            // Handle remote participants
            connectedRoom.participants.forEach(participantConnected);
            connectedRoom.on('participantConnected', participantConnected);
            connectedRoom.on('participantDisconnected', participantDisconnected);

            onShowToast('Connected to video interview', 'success');
        } catch (err: any) {
            console.error('Error connecting to room:', err);
            setError(err.message || 'Failed to connect to video room');
            setIsConnecting(false);
            onShowToast('Failed to connect to video room', 'error');
        }
    };

    const participantConnected = (participant: any) => {
        setParticipants((prev) => [...prev, participant]);

        participant.tracks.forEach((publication: any) => {
            if (publication.isSubscribed) {
                trackSubscribed(publication.track);
            }
        });

        participant.on('trackSubscribed', trackSubscribed);
    };

    const participantDisconnected = (participant: any) => {
        setParticipants((prev) => prev.filter((p) => p !== participant));
    };

    const trackSubscribed = (track: any) => {
        if (track.kind === 'video' && remoteVideoRef.current) {
            remoteVideoRef.current.appendChild(track.attach());
        }
    };

    const toggleVideo = () => {
        if (room) {
            room.localParticipant.videoTracks.forEach((publication: any) => {
                if (isVideoEnabled) {
                    publication.track.disable();
                } else {
                    publication.track.enable();
                }
            });
        }
        setIsVideoEnabled(!isVideoEnabled);
    };

    const toggleAudio = () => {
        if (room) {
            room.localParticipant.audioTracks.forEach((publication: any) => {
                if (isAudioEnabled) {
                    publication.track.disable();
                } else {
                    publication.track.enable();
                }
            });
        }
        setIsAudioEnabled(!isAudioEnabled);
    };

    const endCall = async () => {
        if (room) {
            room.disconnect();
        }

        // Update interview status
        try {
            await videoService.updateInterviewStatus(interview.id, 'completed');
        } catch (e) {
            console.error('Error updating interview status:', e);
        }

        onEnd();
    };

    if (error) {
        return (
            <div className="fixed inset-0 bg-slate-900 flex items-center justify-center z-50 p-4">
                <div className="bg-white rounded-3xl p-8 max-w-md text-center">
                    <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                        <AlertCircle className="w-8 h-8 text-red-600" />
                    </div>
                    <h2 className="text-2xl font-bold text-slate-900 mb-2">Connection Error</h2>
                    <p className="text-slate-600 mb-6">{error}</p>
                    <Button onClick={onEnd} variant="primary">
                        Close
                    </Button>
                </div>
            </div>
        );
    }

    return (
        <div className="fixed inset-0 bg-slate-900 flex flex-col z-50">
            {/* Header */}
            <div className="bg-slate-800/50 backdrop-blur-lg border-b border-slate-700 p-4">
                <div className="max-w-7xl mx-auto flex justify-between items-center">
                    <div>
                        <h2 className="text-white font-bold text-lg">Video Interview</h2>
                        <p className="text-slate-400 text-sm">
                            {interview.clientName} ↔ {interview.caregiverName}
                        </p>
                    </div>
                    {isConnecting && (
                        <div className="flex items-center gap-2 text-primary-400">
                            <Loader2 className="w-4 h-4 animate-spin" />
                            <span className="text-sm">Connecting...</span>
                        </div>
                    )}
                </div>
            </div>

            {/* Video Grid */}
            <div className="flex-1 p-4 grid grid-cols-1 md:grid-cols-2 gap-4 max-w-7xl mx-auto w-full">
                {/* Remote Video (Main) */}
                <div className="relative bg-slate-800 rounded-3xl overflow-hidden shadow-2xl">
                    <video
                        ref={remoteVideoRef}
                        autoPlay
                        playsInline
                        className="w-full h-full object-cover"
                    />
                    {participants.length === 0 && !isConnecting && (
                        <div className="absolute inset-0 flex items-center justify-center">
                            <div className="text-center">
                                <div className="w-24 h-24 bg-slate-700 rounded-full flex items-center justify-center mx-auto mb-4">
                                    <Video className="w-12 h-12 text-slate-500" />
                                </div>
                                <p className="text-slate-400">Waiting for other participant...</p>
                            </div>
                        </div>
                    )}
                    <div className="absolute top-4 left-4 bg-slate-900/80 backdrop-blur-sm px-3 py-2 rounded-lg">
                        <p className="text-white text-sm font-medium">
                            {participants.length > 0 ? participants[0].identity : 'Remote'}
                        </p>
                    </div>
                </div>

                {/* Local Video (Picture-in-Picture) */}
                <div className="relative bg-slate-800 rounded-3xl overflow-hidden shadow-2xl md:max-h-[400px]">
                    <video
                        ref={localVideoRef}
                        autoPlay
                        muted
                        playsInline
                        className="w-full h-full object-cover mirror"
                    />
                    {!isVideoEnabled && (
                        <div className="absolute inset-0 bg-slate-900 flex items-center justify-center">
                            <div className="text-center">
                                <VideoOff className="w-12 h-12 text-slate-500 mx-auto mb-2" />
                                <p className="text-slate-400 text-sm">Camera Off</p>
                            </div>
                        </div>
                    )}
                    <div className="absolute top-4 left-4 bg-slate-900/80 backdrop-blur-sm px-3 py-2 rounded-lg">
                        <p className="text-white text-sm font-medium">You ({userName})</p>
                    </div>
                </div>
            </div>

            {/* Controls */}
            <div className="bg-slate-800/50 backdrop-blur-lg border-t border-slate-700 p-6">
                <div className="max-w-md mx-auto flex justify-center gap-4">
                    {/* Toggle Video */}
                    <button
                        onClick={toggleVideo}
                        className={`w-14 h-14 rounded-full flex items-center justify-center transition-all ${isVideoEnabled
                                ? 'bg-slate-700 hover:bg-slate-600 text-white'
                                : 'bg-red-600 hover:bg-red-700 text-white'
                            }`}
                    >
                        {isVideoEnabled ? (
                            <Video className="w-6 h-6" />
                        ) : (
                            <VideoOff className="w-6 h-6" />
                        )}
                    </button>

                    {/* Toggle Audio */}
                    <button
                        onClick={toggleAudio}
                        className={`w-14 h-14 rounded-full flex items-center justify-center transition-all ${isAudioEnabled
                                ? 'bg-slate-700 hover:bg-slate-600 text-white'
                                : 'bg-red-600 hover:bg-red-700 text-white'
                            }`}
                    >
                        {isAudioEnabled ? (
                            <Mic className="w-6 h-6" />
                        ) : (
                            <MicOff className="w-6 h-6" />
                        )}
                    </button>

                    {/* End Call */}
                    <button
                        onClick={endCall}
                        className="w-14 h-14 rounded-full bg-red-600 hover:bg-red-700 text-white flex items-center justify-center transition-all"
                    >
                        <PhoneOff className="w-6 h-6" />
                    </button>
                </div>
            </div>

            <style>{`
        .mirror {
          transform: scaleX(-1);
        }
      `}</style>
        </div>
    );
};
