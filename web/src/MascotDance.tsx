import { useEffect, useRef } from 'react';
import type { Mascot, MascotClip } from './mascot/mascot.js';

/**
 * The meetup mascot, alive on the projector while a step generates. three.js and the mascot module are loaded
 * lazily, so the projector bundle only pays for them when something is actually generating.
 */
export function MascotDance({ clip = 'dance', smoke = true }: { clip?: MascotClip; smoke?: boolean }) {
  const host = useRef<HTMLDivElement | null>(null);
  const mascot = useRef<Mascot | null>(null);

  useEffect(() => {
    let alive = true;
    let cleanup = () => {};
    Promise.all([import('three'), import('./mascot/mascot.js')]).then(([THREE, M]) => {
      const el = host.current;
      if (!alive || !el) return;
      const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      el.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      // framed tight: the mascot (~1 unit tall) fills the box with a little headroom for dance moves
      const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
      camera.position.set(1.05, 0.95, 1.85);
      camera.lookAt(0, 0.52, 0);
      scene.add(new THREE.HemisphereLight(0xfff2e6, 0x2a2440, 1.4));
      const sun = new THREE.DirectionalLight(0xffffff, 2.2);
      sun.position.set(2, 4, 3);
      sun.castShadow = true;
      sun.shadow.mapSize.set(1024, 1024);
      scene.add(sun);
      const rim = new THREE.DirectionalLight(0x7fd0ff, 1.1); // cool rim light from behind, reads well on black
      rim.position.set(-2.5, 2, -2.5);
      scene.add(rim);
      const floor = new THREE.Mesh(new THREE.CircleGeometry(0.9, 48), new THREE.ShadowMaterial({ opacity: 0.45 }));
      floor.rotation.x = -Math.PI / 2;
      floor.receiveShadow = true;
      scene.add(floor);

      const m = M.createMascot(THREE, { smoke });
      mascot.current = m;
      scene.add(m.root);
      m.play(clip);

      const fit = () => {
        const w = el.clientWidth || 1, h = el.clientHeight || 1;
        renderer.setSize(w, h, false);
        renderer.domElement.style.width = '100%';
        renderer.domElement.style.height = '100%';
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      const ro = new ResizeObserver(fit);
      ro.observe(el);
      fit();

      const clock = new THREE.Clock();
      let raf = 0;
      const tick = () => {
        raf = requestAnimationFrame(tick);
        const dt = Math.min(0.05, clock.getDelta());
        m.root.rotation.y = Math.sin(clock.elapsedTime * 0.6) * 0.45; // a slow sway so every side gets seen
        m.update(dt);
        renderer.render(scene, camera);
      };
      tick();
      cleanup = () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        m.dispose();
        floor.geometry.dispose();
        (floor.material as import('three').Material).dispose();
        renderer.dispose();
        renderer.domElement.remove();
        mascot.current = null;
      };
    }, () => { /* no WebGL or failed to load: the waiting card still works without the mascot */ });
    return () => { alive = false; cleanup(); };
  }, [smoke]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { mascot.current?.play(clip); }, [clip]);

  return <div ref={host} className="h-full w-full" />;
}
