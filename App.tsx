
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Blob } from '@google/genai';
import { VrmViewer } from './components/VrmViewer';
import { encode, decode, decodeAudioData } from './utils/audio';
import type { TranscriptEntry, AppStatus } from './types';
import { Mic, MicOff, Bot, Loader2, Power } from 'lucide-react';

const API_KEY = process.env.API_KEY;

const initialVrmModels = [
  { name: 'Alicia Solid', url: 'https://pixiv.github.io/three-vrm/packages/three-vrm/examples/models/VRM1_Alicia_v0.50.vrm' },
  { name: 'Constraint Twist Sample', url: 'https://pixiv.github.io/three-vrm/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm' },
  { name: 'Alicia Classic', url: 'https://pixiv.github.io/three-vrm/packages/three-vrm/examples/models/VRM0_Alicia_v0.40.vrm' },
];

const App: React.FC = () => {
    const [status, setStatus] = useState<AppStatus>('idle');
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [transcripts, setTranscripts] = useState<TranscriptEntry[]>([]);
    const [isModelSpeaking, setIsModelSpeaking] = useState(false);
    const [vrmModels, setVrmModels] = useState(initialVrmModels);
    const [modelUrl, setModelUrl] = useState(() => {
        return localStorage.getItem('vrm_app_last_model_url') || initialVrmModels[0].url;
    });
    const [customModelUrl, setCustomModelUrl] = useState('');
    const transcriptEndRef = useRef<HTMLDivElement>(null);

    const sessionPromise = useRef<Promise<any> | null>(null);
    const inputAudioContext = useRef<AudioContext | null>(null);
    const outputAudioContext = useRef<AudioContext | null>(null);
    const scriptProcessor = useRef<ScriptProcessorNode | null>(null);
    const mediaStreamSource = useRef<MediaStreamAudioSourceNode | null>(null);
    const stream = useRef<MediaStream | null>(null);

    const currentInputTranscription = useRef('');
    const currentOutputTranscription = useRef('');
    const nextStartTime = useRef(0);
    const audioSources = useRef(new Set<AudioBufferSourceNode>());
    const ai = useRef<GoogleGenAI | null>(null);

    useEffect(() => {
        localStorage.setItem('vrm_app_last_model_url', modelUrl);
    }, [modelUrl]);

    useEffect(() => {
      transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [transcripts]);

    const addTranscript = (speaker: 'user' | 'model', text: string) => {
        setTranscripts(prev => [...prev, { speaker, text, timestamp: new Date() }]);
    };

    const cleanup = useCallback(() => {
        scriptProcessor.current?.disconnect();
        scriptProcessor.current = null;
        mediaStreamSource.current?.disconnect();
        mediaStreamSource.current = null;

        inputAudioContext.current?.close().catch(console.error);
        inputAudioContext.current = null;
        outputAudioContext.current?.close().catch(console.error);
        outputAudioContext.current = null;

        stream.current?.getTracks().forEach(track => track.stop());
        stream.current = null;
        
        for (const source of audioSources.current.values()) {
            source.stop();
        }
        audioSources.current.clear();
        nextStartTime.current = 0;
        
        sessionPromise.current = null;
        setIsModelSpeaking(false);
    }, []);

    const stopSession = useCallback(async () => {
        if (status !== 'idle' && status !== 'error') {
            setStatus('idle');
            if (sessionPromise.current) {
                try {
                    const session = await sessionPromise.current;
                    session.close();
                } catch (error) {
                    console.error("Error closing session:", error);
                }
            }
            cleanup();
        }
    }, [cleanup, status]);

    const startSession = useCallback(async () => {
        setStatus('connecting');
        setErrorMessage(null);

        if (!API_KEY) {
            const msg = "API_KEY is not configured. Please set it up to use the application.";
            setStatus('error');
            addTranscript('model', msg);
            setErrorMessage(msg);
            return;
        }
        
        ai.current = new GoogleGenAI({ apiKey: API_KEY });

        try {
            inputAudioContext.current = new ((window as any).AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
            outputAudioContext.current = new ((window as any).AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
            
            stream.current = await navigator.mediaDevices.getUserMedia({ audio: true });

            sessionPromise.current = ai.current.live.connect({
                model: 'gemini-2.5-flash-native-audio-preview-12-2025',
                config: {
                    responseModalities: [Modality.AUDIO],
                    inputAudioTranscription: {},
                    outputAudioTranscription: {},
                    systemInstruction: "You are a friendly virtual assistant. Keep your answers concise and conversational.",
                },
                callbacks: {
                    onopen: () => {
                        setStatus('listening');
                        if (!stream.current || !inputAudioContext.current) return;

                        mediaStreamSource.current = inputAudioContext.current.createMediaStreamSource(stream.current);
                        scriptProcessor.current = inputAudioContext.current.createScriptProcessor(4096, 1, 1);
                        
                        scriptProcessor.current.onaudioprocess = (audioProcessingEvent) => {
                            const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
                            const pcmBlob: Blob = {
                                data: encode(new Uint8Array(new Int16Array(inputData.map(x => x * 32768)).buffer)),
                                mimeType: 'audio/pcm;rate=16000',
                            };
                            
                            if (sessionPromise.current) {
                                sessionPromise.current.then((session) => {
                                    session.sendRealtimeInput({ media: pcmBlob });
                                });
                            }
                        };
                        
                        mediaStreamSource.current.connect(scriptProcessor.current);
                        scriptProcessor.current.connect(inputAudioContext.current.destination);
                    },
                    onmessage: async (message: LiveServerMessage) => {
                        if (message.serverContent?.outputTranscription) {
                            currentOutputTranscription.current += message.serverContent.outputTranscription.text;
                        }
                        if (message.serverContent?.inputTranscription) {
                            currentInputTranscription.current += message.serverContent.inputTranscription.text;
                        }

                        if (message.serverContent?.turnComplete) {
                            if (currentInputTranscription.current.trim()) {
                                addTranscript('user', currentInputTranscription.current.trim());
                            }
                            if (currentOutputTranscription.current.trim()) {
                                addTranscript('model', currentOutputTranscription.current.trim());
                            }
                            currentInputTranscription.current = '';
                            currentOutputTranscription.current = '';
                        }
                        
                        const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
                        if (audioData && outputAudioContext.current) {
                           setIsModelSpeaking(true);
                           const decodedAudio = decode(audioData);
                           const audioBuffer = await decodeAudioData(decodedAudio, outputAudioContext.current, 24000, 1);
                           const source = outputAudioContext.current.createBufferSource();
                           source.buffer = audioBuffer;
                           source.connect(outputAudioContext.current.destination);
                           
                           const currentTime = outputAudioContext.current.currentTime;
                           const startTime = Math.max(currentTime, nextStartTime.current);
                           source.start(startTime);
                           nextStartTime.current = startTime + audioBuffer.duration;
                           audioSources.current.add(source);
                           source.onended = () => {
                               audioSources.current.delete(source);
                               if (audioSources.current.size === 0) {
                                   setIsModelSpeaking(false);
                               }
                           };
                        }

                        if (message.serverContent?.interrupted) {
                            for (const source of audioSources.current.values()) {
                                source.stop();
                            }
                            audioSources.current.clear();
                            nextStartTime.current = 0;
                            setIsModelSpeaking(false);
                        }
                    },
                    onerror: (e: ErrorEvent) => {
                        console.error("Session error:", e);
                        const msg = `A session error occurred: ${e.message}. Please try reconnecting.`;
                        setStatus('error');
                        addTranscript('model', msg);
                        setErrorMessage(msg);
                        cleanup();
                    },
                    onclose: () => {
                        if(status !== 'error') setStatus('idle');
                        cleanup();
                    },
                },
            });
        } catch (error) {
            console.error("Failed to start session:", error);
            setStatus('error');
            let msg = 'An unexpected error occurred while starting the session.';
            if (error instanceof Error) {
                if (error.name === 'NotAllowedError' || error.message.includes('permission denied')) {
                    msg = "Microphone access was denied. Please allow microphone access in your browser settings and try again.";
                } else {
                    msg = `Failed to start session: ${error.message}`;
                }
            }
            addTranscript('model', msg);
            setErrorMessage(msg);
            cleanup();
        }
    }, [cleanup, status]);

    const handleButtonClick = () => {
        if (status === 'idle' || status === 'error') {
            setTranscripts([{ speaker: 'model', text: 'Hello! How can I help you today?', timestamp: new Date() }]);
            startSession();
        } else {
            stopSession();
        }
    };
    
    useEffect(() => {
        return () => { stopSession(); }
    }, [stopSession]);

    const handleLoadCustomModel = (e: React.FormEvent) => {
        e.preventDefault();
        let url = customModelUrl.trim();
        if (!url) return;
    
        if (url.startsWith('https://github.com/')) {
            url = url.replace('https://github.com/', 'https://raw.githubusercontent.com/').replace('/blob/', '/');
        }
    
        const existingModel = vrmModels.find(model => model.url === url);
        if (existingModel) {
            setModelUrl(url);
        } else {
            const modelName = 'Custom: ' + url.substring(url.lastIndexOf('/') + 1);
            const newModel = { name: modelName, url: url };
            setVrmModels(prevModels => [...prevModels, newModel]);
            setModelUrl(url);
        }
        setCustomModelUrl('');
    };

    const getStatusIndicator = () => {
        switch (status) {
            case 'connecting': return { color: 'bg-yellow-500', text: 'Connecting...' };
            case 'listening': return { color: 'bg-green-500', text: 'Listening' };
            case 'error': return { color: 'bg-red-500', text: 'Error' };
            case 'idle':
            default: return { color: 'bg-gray-500', text: 'Idle' };
        }
    };
    const { color: statusColor, text: statusText } = getStatusIndicator();

    const renderActionButton = () => {
        const isDisabled = status === 'connecting';
        let icon;
        let ringColor = 'ring-gray-500';

        switch (status) {
            case 'connecting':
                icon = <Loader2 className="w-8 h-8 animate-spin" />;
                break;
            case 'listening':
                icon = <MicOff className="w-8 h-8" />;
                ringColor = 'ring-red-500';
                break;
            case 'idle':
            case 'error':
            default:
                icon = <Mic className="w-8 h-8" />;
                ringColor = 'ring-green-500';
                break;
        }

        return (
            <button
                onClick={handleButtonClick}
                disabled={isDisabled}
                className={`relative w-24 h-24 rounded-full flex items-center justify-center transition-all duration-300 ease-in-out focus:outline-none focus:ring-4 ${ringColor} ${isDisabled ? 'bg-gray-600 cursor-not-allowed' : 'bg-slate-700 hover:bg-slate-600'}`}
                aria-label={status === 'listening' ? 'Stop listening' : 'Start listening'}
            >
                <div className={`absolute inset-0 rounded-full border-4 ${status === 'listening' ? 'border-cyan-400 animate-pulse' : 'border-transparent'}`}></div>
                <span className="text-white">{icon}</span>
            </button>
        );
    };

    return (
        <div className="w-screen h-screen flex flex-col md:flex-row bg-slate-900">
            {/* VRM Viewer Pane */}
            <div className="flex-grow h-1/2 md:h-full w-full md:w-auto relative">
                <VrmViewer isSpeaking={isModelSpeaking} modelUrl={modelUrl} />
            </div>

            {/* Control Pane */}
            <div className="w-full md:w-96 lg:w-[450px] h-1/2 md:h-full bg-slate-800 flex flex-col p-4 border-l-2 border-slate-700 shadow-2xl">
                {/* Header */}
                <div className="flex-shrink-0 flex items-center justify-between pb-4 border-b border-slate-700">
                    <h1 className="text-xl font-bold text-white">AI VRM Assistant</h1>
                    <div className="flex items-center space-x-2">
                        <div className={`w-3 h-3 rounded-full transition-colors ${statusColor}`}></div>
                        <span className="text-sm text-gray-300">{statusText}</span>
                    </div>
                </div>

                {/* Model Selection */}
                <div className="flex-shrink-0 py-4 space-y-4">
                     <div>
                        <label htmlFor="model-select" className="block text-sm font-medium text-gray-300 mb-1">Select Model</label>
                        <select
                            id="model-select"
                            value={modelUrl}
                            onChange={(e) => setModelUrl(e.target.value)}
                            disabled={status !== 'idle' && status !== 'error'}
                            className="w-full bg-slate-900 border border-slate-600 rounded-md py-2 px-3 text-white focus:outline-none focus:ring-2 focus:ring-cyan-500 disabled:opacity-50"
                        >
                            {vrmModels.map((model) => (
                                <option key={model.url} value={model.url}>
                                    {model.name}
                                </option>
                            ))}
                        </select>
                    </div>
                    <form onSubmit={handleLoadCustomModel}>
                        <label htmlFor="custom-model-url" className="block text-sm font-medium text-gray-300 mb-1">Load from GitHub URL</label>
                        <div className="flex space-x-2">
                            <input
                                id="custom-model-url"
                                type="text"
                                value={customModelUrl}
                                onChange={(e) => setCustomModelUrl(e.target.value)}
                                placeholder="e.g., https://github.com/.../model.vrm"
                                disabled={status !== 'idle' && status !== 'error'}
                                className="flex-grow bg-slate-900 border border-slate-600 rounded-md py-2 px-3 text-white focus:outline-none focus:ring-2 focus:ring-cyan-500 disabled:opacity-50"
                            />
                            <button
                                type="submit"
                                disabled={(status !== 'idle' && status !== 'error') || !customModelUrl}
                                className="px-4 py-2 bg-cyan-600 hover:bg-cyan-700 disabled:bg-slate-600 text-white font-semibold rounded-md transition-colors disabled:opacity-50"
                            >
                                Load
                            </button>
                        </div>
                    </form>
                </div>
                
                {/* Transcript Area */}
                <div className="flex-grow overflow-y-auto my-4 pr-2 -mr-2 space-y-4">
                    {transcripts.map((entry, index) => (
                        <div key={index} className={`flex items-end gap-2 ${entry.speaker === 'user' ? 'justify-end' : 'justify-start'}`}>
                            {entry.speaker === 'model' && <Bot className="w-8 h-8 p-1.5 rounded-full bg-cyan-500 text-white flex-shrink-0" />}
                            <div className={`px-4 py-2 rounded-lg max-w-xs md:max-w-sm text-white ${entry.speaker === 'user' ? 'bg-blue-600 rounded-br-none' : 'bg-slate-700 rounded-bl-none'}`}>
                                <p className="text-sm">{entry.text}</p>
                                <p className="text-xs text-gray-400 mt-1 text-right">{entry.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
                            </div>
                        </div>
                    ))}
                    <div ref={transcriptEndRef} />
                </div>

                {/* Footer & Action Button */}
                <div className="flex-shrink-0 flex flex-col items-center pt-4 border-t border-slate-700">
                     <div className="h-6 mb-2">
                        {status === 'error' && errorMessage && <p className="text-red-400 text-center text-sm">{errorMessage}</p>}
                    </div>
                    {renderActionButton()}
                </div>
            </div>
        </div>
    );
};

export default App;
