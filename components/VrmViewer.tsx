
import React, { useRef, useEffect, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { Palette, Info, Save, Check, Edit } from 'lucide-react';

interface VrmViewerProps {
    isSpeaking: boolean;
    modelUrl: string;
}

type BackgroundMode = 'green' | 'solid' | 'gradient';

interface VrmMeta {
    title?: string;
    author?: string;
}

const createGradientTexture = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 512;
    const context = canvas.getContext('2d');
    if (!context) return null;

    const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, '#1a202c'); // Dark blue/gray top
    gradient.addColorStop(1, '#2d3748'); // Lighter gray bottom

    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
};

export const VrmViewer: React.FC<VrmViewerProps> = ({ isSpeaking, modelUrl }) => {
    const mountRef = useRef<HTMLDivElement>(null);
    const vrmRef = useRef<any>(null);
    const mixerRef = useRef<THREE.AnimationMixer | null>(null);
    const clock = useRef(new THREE.Clock());
    const sceneRef = useRef<THREE.Scene | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const controlsRef = useRef<OrbitControls | null>(null);

    const [isLoading, setIsLoading] = useState(true);
    const [loadingProgress, setLoadingProgress] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [modelMeta, setModelMeta] = useState<VrmMeta | null>(null);
    const [isCameraSaved, setIsCameraSaved] = useState(false);
    const [isEditingMeta, setIsEditingMeta] = useState(false);
    const [editableMeta, setEditableMeta] = useState<VrmMeta>({ title: '', author: '' });

    const [backgroundMode, setBackgroundMode] = useState<BackgroundMode>(() => {
        return (localStorage.getItem('vrm_app_background_mode') as BackgroundMode) || 'gradient';
    });

    useEffect(() => {
        const scene = sceneRef.current;
        if (!scene) return;

        localStorage.setItem('vrm_app_background_mode', backgroundMode);

        let background: THREE.Color | THREE.Texture | null = null;
        switch (backgroundMode) {
            case 'green':
                background = new THREE.Color(0x00ff00);
                break;
            case 'solid':
                background = new THREE.Color(0x2d3748);
                break;
            case 'gradient':
                background = createGradientTexture();
                break;
        }
        scene.background = background;
    }, [backgroundMode]);

    useEffect(() => {
        const mountNode = mountRef.current;
        if (!mountNode) return;

        setIsLoading(true);
        setLoadingProgress(0);
        setError(null);
        setModelMeta(null);
        vrmRef.current = null;
        mixerRef.current = null;

        let animationFrameId: number;
        
        const scene = new THREE.Scene();
        sceneRef.current = scene;

        let initialBackground: THREE.Color | THREE.Texture | null = null;
        switch (backgroundMode) {
            case 'green': initialBackground = new THREE.Color(0x00ff00); break;
            case 'solid': initialBackground = new THREE.Color(0x2d3748); break;
            case 'gradient': initialBackground = createGradientTexture(); break;
        }
        scene.background = initialBackground;

        const camera = new THREE.PerspectiveCamera(30.0, mountNode.clientWidth / mountNode.clientHeight, 0.1, 20.0);
        cameraRef.current = camera;
        
        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(mountNode.clientWidth, mountNode.clientHeight);
        renderer.setPixelRatio(window.devicePixelRatio);
        mountNode.appendChild(renderer.domElement);
        
        // --- Professional Lighting Setup ---

        // Ambient light to soften shadows and provide base illumination
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
        scene.add(ambientLight);

        // Main directional light (key light)
        const keyLight = new THREE.DirectionalLight(0xffffff, 1.0);
        keyLight.position.set(0.5, 1.0, 1.0).normalize();
        scene.add(keyLight);

        // A softer fill light from the opposite side
        const fillLight = new THREE.DirectionalLight(0xffffff, 0.5);
        fillLight.position.set(-0.5, 0.5, -1.0).normalize();
        scene.add(fillLight);
        
        const controls = new OrbitControls(camera, renderer.domElement);
        controlsRef.current = controls;
        controls.screenSpacePanning = true;
        controls.minDistance = 0.5;
        controls.maxDistance = 50;
        controls.maxPolarAngle = Math.PI / 2;

        const loader = new GLTFLoader();
        loader.register((parser) => new VRMLoaderPlugin(parser));
        
        loader.load(
            modelUrl,
            (gltf) => {
                const vrm = gltf.userData.vrm;
                vrmRef.current = vrm;

                const savedMetaRaw = localStorage.getItem(`vrm_app_metadata_${modelUrl}`);
                if (savedMetaRaw) {
                    try {
                        setModelMeta(JSON.parse(savedMetaRaw));
                    } catch (e) {
                        console.error("Failed to parse saved metadata", e);
                        if (vrm.meta) {
                            setModelMeta({ title: vrm.meta.title, author: vrm.meta.author });
                        }
                    }
                } else if (vrm.meta) {
                    setModelMeta({ title: vrm.meta.title, author: vrm.meta.author });
                }
                
                if (vrm.meta.vrmVersion === '0.0') {
                    VRMUtils.rotateVRM0(vrm);
                }
                
                scene.add(vrm.scene);

                const autoCenterCamera = () => {
                    const box = new THREE.Box3().setFromObject(vrm.scene);
                    const size = box.getSize(new THREE.Vector3());
                    const center = box.getCenter(new THREE.Vector3());
                    const fov = camera.fov * (Math.PI / 180);
                    const cameraDistance = (size.y / 2) / Math.tan(fov / 2) * 1.5; 
                    camera.position.set(center.x, center.y, center.z + cameraDistance);
                    controls.target.copy(center);
                    controls.update();
                };

                const savedSettingsRaw = localStorage.getItem(`vrm_app_camera_settings_${modelUrl}`);
                if (savedSettingsRaw) {
                    try {
                        const savedSettings = JSON.parse(savedSettingsRaw);
                        camera.position.set(savedSettings.position.x, savedSettings.position.y, savedSettings.position.z);
                        controls.target.set(savedSettings.target.x, savedSettings.target.y, savedSettings.target.z);
                        camera.zoom = savedSettings.zoom;
                        camera.updateProjectionMatrix();
                        controls.update();
                    } catch (e) {
                        console.error("Failed to parse saved camera settings.", e);
                        autoCenterCamera();
                    }
                } else {
                    autoCenterCamera();
                }

                if (gltf.animations && gltf.animations.length > 0) {
                    mixerRef.current = new THREE.AnimationMixer(vrm.scene);
                    const idleClip = gltf.animations.find(clip => clip.name.toLowerCase().includes('idle')) || gltf.animations[0];
                    if (idleClip) {
                        mixerRef.current.clipAction(idleClip).play();
                    }
                }
                setIsLoading(false);
            },
            (progress) => setLoadingProgress((progress.loaded / progress.total) * 100),
            (err) => {
                console.error("Failed to load VRM model:", err);
                setError("Failed to load model. Check URL and file format.");
                setIsLoading(false);
            }
        );

        const animate = () => {
            animationFrameId = requestAnimationFrame(animate);
            const delta = clock.current.getDelta();
            if (mixerRef.current) mixerRef.current.update(delta);
            if (vrmRef.current) vrmRef.current.update(delta);
            controls.update();
            renderer.render(scene, camera);
        };
        animate();

        const handleResize = () => {
            if (!mountNode) return;
            camera.aspect = mountNode.clientWidth / mountNode.clientHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(mountNode.clientWidth, mountNode.clientHeight);
        };
        window.addEventListener('resize', handleResize);

        return () => {
            window.removeEventListener('resize', handleResize);
            cancelAnimationFrame(animationFrameId);
            if (mountNode && renderer.domElement) {
                mountNode.removeChild(renderer.domElement);
            }
            controls.dispose();
            renderer.dispose();
        };
    }, [modelUrl]);

    useEffect(() => {
        const vrm = vrmRef.current;
        if (!vrm?.expressionManager) return;
        
        if (isSpeaking) {
            vrm.expressionManager.setValue('aa', 0.6 + Math.random() * 0.4);
        } else {
            vrm.expressionManager.setValue('aa', 0);
        }
    }, [isSpeaking]);

    const toggleBackground = () => {
        setBackgroundMode(prev => {
            if (prev === 'green') return 'solid';
            if (prev === 'solid') return 'gradient';
            return 'green';
        });
    };
    
    const handleSaveCameraState = () => {
        if (!cameraRef.current || !controlsRef.current) return;
        const settings = {
            position: cameraRef.current.position.clone(),
            target: controlsRef.current.target.clone(),
            zoom: cameraRef.current.zoom,
        };
        localStorage.setItem(`vrm_app_camera_settings_${modelUrl}`, JSON.stringify(settings));
        setIsCameraSaved(true);
        setTimeout(() => setIsCameraSaved(false), 2000);
    };

    const handleOpenEditMeta = () => {
        setEditableMeta({
            title: modelMeta?.title || '',
            author: modelMeta?.author || '',
        });
        setIsEditingMeta(true);
    };

    const handleMetaInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { name, value } = e.target;
        setEditableMeta(prev => ({ ...prev, [name]: value }));
    };

    const handleSaveMeta = () => {
        setModelMeta(editableMeta);
        localStorage.setItem(`vrm_app_metadata_${modelUrl}`, JSON.stringify(editableMeta));
        setIsEditingMeta(false);
    };

    return (
        <div className="w-full h-full relative bg-gray-800">
            <div className="absolute top-4 right-4 z-20 flex space-x-2">
                <button
                    onClick={handleSaveCameraState}
                    className={`p-2 bg-slate-900 bg-opacity-60 rounded-full text-white hover:bg-opacity-80 transition-all duration-300 ${isCameraSaved ? 'bg-green-600' : ''}`}
                    aria-label="Save camera position"
                    title="Save camera position"
                >
                    {isCameraSaved ? <Check size={24} /> : <Save size={24} />}
                </button>
                <button
                    onClick={toggleBackground}
                    className="p-2 bg-slate-900 bg-opacity-60 rounded-full text-white hover:bg-opacity-80 transition-opacity"
                    aria-label="Change background"
                    title="Change background"
                >
                    <Palette size={24} />
                </button>
            </div>
            
            {!isLoading && (
                <div className="absolute bottom-4 left-4 z-20 p-3 bg-slate-900 bg-opacity-70 rounded-lg text-white text-xs max-w-xs shadow-lg backdrop-blur-sm">
                     <div className="flex items-start justify-between">
                        <div className="flex items-start mr-2 overflow-hidden">
                            <Info size={16} className="mr-2 mt-0.5 text-cyan-400 flex-shrink-0" />
                            <div>
                                <h4 className="font-bold truncate" title={modelMeta?.title}>{modelMeta?.title || <span className="italic text-gray-400">Untitled</span>}</h4>
                                <p className="text-gray-300 truncate" title={modelMeta?.author}>
                                    {modelMeta?.author ? `by ${modelMeta.author}` : <span className="italic text-gray-400">Unknown Author</span>}
                                </p>
                            </div>
                        </div>
                        <button onClick={handleOpenEditMeta} className="p-1 text-gray-400 hover:text-white transition-colors flex-shrink-0" aria-label="Edit model metadata" title="Edit model metadata">
                            <Edit size={14} />
                        </button>
                    </div>
                </div>
            )}

            {isEditingMeta && (
                <div className="absolute inset-0 z-30 bg-black bg-opacity-60 flex items-center justify-center backdrop-blur-sm p-4">
                    <div className="bg-gray-800 rounded-lg shadow-2xl p-6 w-full max-w-md border border-gray-700">
                        <h3 className="text-lg font-semibold mb-4 text-white">Edit Model Info</h3>
                        <div className="space-y-4">
                            <div>
                                <label htmlFor="title" className="block text-sm font-medium text-gray-300 mb-1">Title</label>
                                <input
                                    type="text"
                                    name="title"
                                    id="title"
                                    value={editableMeta.title}
                                    onChange={handleMetaInputChange}
                                    className="w-full bg-gray-900 border border-gray-600 rounded-md py-2 px-3 text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                                />
                            </div>
                            <div>
                                <label htmlFor="author" className="block text-sm font-medium text-gray-300 mb-1">Author</label>
                                <input
                                    type="text"
                                    name="author"
                                    id="author"
                                    value={editableMeta.author}
                                    onChange={handleMetaInputChange}
                                    className="w-full bg-gray-900 border border-gray-600 rounded-md py-2 px-3 text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                                />
                            </div>
                        </div>
                        <div className="mt-6 flex justify-end space-x-3">
                            <button
                                onClick={() => setIsEditingMeta(false)}
                                className="px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white font-semibold rounded-md transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleSaveMeta}
                                className="px-4 py-2 bg-cyan-600 hover:bg-cyan-700 text-white font-semibold rounded-md transition-colors"
                            >
                                Save Changes
                            </button>
                        </div>
                    </div>
                </div>
            )}
            
            <div ref={mountRef} className={`w-full h-full transition-opacity duration-300 ${isLoading || error ? 'opacity-0' : 'opacity-100'}`} />
            
            {isLoading && (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-white z-10 bg-slate-900 bg-opacity-75">
                    <div className="animate-spin rounded-full h-16 w-16 border-t-2 border-b-2 border-cyan-400 mb-4"></div>
                    <p className="text-xl mb-2">Loading Model...</p>
                    <div className="w-64 bg-slate-700 rounded-full h-2.5">
                        <div
                            className="bg-cyan-400 h-2.5 rounded-full transition-all duration-150"
                            style={{ width: `${loadingProgress}%` }}
                        ></div>
                    </div>
                    <p className="text-sm mt-2">{Math.round(loadingProgress)}%</p>
                </div>
            )}
            
            {error && !isLoading && (
                 <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-900 p-4 text-white z-10">
                    <p className="text-2xl font-bold mb-4 text-red-500">Error</p>
                    <p className="text-red-300 text-center max-w-md">{error}</p>
                </div>
            )}
        </div>
    );
};
