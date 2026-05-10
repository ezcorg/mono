/**
 * Slide-in animation for demo content (markdown editor / codeblock) once
 * its async mount has completed. The demo container is large (70vh+) so
 * the vertical offset needs to be substantial — small nudges get lost
 * against the surrounding layout.
 *
 * Wraps in `requestAnimationFrame` so the editor's DOM has had a frame
 * to lay out and paint before the animation samples its starting state.
 * Uses `transform: translateY` rather than the standalone `translate`
 * property so it composes cleanly even if the editor's own internals
 * apply transforms.
 */
export function slideInDemo(el: HTMLElement | null | undefined): void {
    if (!el || typeof el.animate !== "function") return;
    requestAnimationFrame(() => {
        el.animate(
            [
                { transform: "translateY(200px)", opacity: 0 },
                { transform: "translateY(0)", opacity: 1 },
            ],
            {
                duration: 640,
                easing: "cubic-bezier(0.22, 1, 0.36, 1)",
                fill: "both",
            },
        );
    });
}
