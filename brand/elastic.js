const SVG_NS = "http://www.w3.org/2000/svg";
function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
}
export function mountElasticUnderlines(effectRoot, selector = ".elastic-underline, .elastic-nav-label, u, a") {
    const activeUnderlines = new Map();
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    let disposed = false;
    effectRoot.classList.add("elastic-effect-root");
    function activate(mark) {
        const segments = [];
        let activeSegment = 0;
        let pullX = 0;
        let displacement = 0;
        let velocity = 0;
        let animationFrame = 0;
        let previousMouseY = null;
        let mouseDirection = 1;
        let activeTouchId = null;
        let previousTouchY = 0;
        let touchStartX = 0;
        let touchStartY = 0;
        let touchMoved = false;
        function addSegment() {
            const svg = document.createElementNS(SVG_NS, "svg");
            const path = document.createElementNS(SVG_NS, "path");
            svg.classList.add("elastic-underline-svg");
            svg.style.height = '24px';
            svg.setAttribute("aria-hidden", "true");
            svg.setAttribute("focusable", "false");
            svg.setAttribute("preserveAspectRatio", "none");
            path.classList.add("elastic-underline-path");
            svg.appendChild(path);
            effectRoot.appendChild(svg);
            segments.push({ svg, path });
        }
        function syncSegments(count) {
            while (segments.length < count)
                addSegment();
            while (segments.length > count)
                segments.pop()?.svg.remove();
        }
        function lineRects() {
            // Text ranges keep padded links from producing an underline across the entire button box.
            if (mark.matches('a')) {
                const lines = [];
                const walker = document.createTreeWalker(mark, NodeFilter.SHOW_TEXT);
                while (walker.nextNode()) {
                    if (!walker.currentNode.textContent.trim() || walker.currentNode.parentElement?.closest('svg')) continue;
                    const range = document.createRange();
                    range.selectNodeContents(walker.currentNode);
                    for (const rect of range.getClientRects()) {
                        if (rect.width <= .5 || rect.height <= .5) continue;
                        const line = lines.find((item) => Math.abs(item.top - rect.top) < 1 && Math.abs(item.bottom - rect.bottom) < 1);
                        if (line) { line.left = Math.min(line.left, rect.left); line.right = Math.max(line.right, rect.right); line.width = line.right - line.left; }
                        else lines.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height });
                    }
                }
                return lines;
            }
            return Array.from(mark.getClientRects()).filter((rect) => rect.width > 0.5 && rect.height > 0.5);
        }
        function draw() {
            if (!mark.isConnected)
                return;
            const rootBounds = effectRoot.getBoundingClientRect();
            const rects = lineRects();
            syncSegments(rects.length);
            if (!rects.length)
                return;
            activeSegment = clamp(activeSegment, 0, rects.length - 1);
            const markStyle = window.getComputedStyle(mark);
            const fontSize = Number.parseFloat(markStyle.fontSize) || 16;
            const lineHeight = Number.parseFloat(markStyle.lineHeight) || fontSize * 1.2;
            const lowerLeading = Math.max((lineHeight - fontSize) / 2, 0);
            rects.forEach((rect, index) => {
                const { svg, path } = segments[index];
                svg.style.opacity = markStyle.getPropertyValue('--elastic-visible').trim() === '0' && displacement === 0 ? '0' : '1';
                const width = Math.max(rect.width, 1);
                const segmentPullX = index === activeSegment ? clamp(pullX || width / 2, 0, width) : width / 2;
                const segmentDisplacement = index === activeSegment ? displacement : 0;
                const baseline = 2;
                const pulledY = baseline + segmentDisplacement;
                const influence = clamp(width * 0.38, 28, 68);
                const leftEdge = clamp(segmentPullX - influence, 0, width);
                const rightEdge = clamp(segmentPullX + influence, 0, width);
                const leftControl = clamp(segmentPullX - influence * 0.3, leftEdge, segmentPullX);
                const rightControl = clamp(segmentPullX + influence * 0.3, segmentPullX, rightEdge);
                svg.style.left = `${rect.left - rootBounds.left + effectRoot.scrollLeft - effectRoot.clientLeft}px`;
                svg.style.top = `${rect.bottom - rootBounds.top + effectRoot.scrollTop - effectRoot.clientTop - lowerLeading - baseline + 6}px`;
                svg.style.width = `${width}px`;
                svg.setAttribute("viewBox", `0 0 ${width} 26`);
                path.setAttribute("d", [
                    `M 0 ${baseline}`,
                    `L ${leftEdge} ${baseline}`,
                    `C ${leftControl} ${baseline}, ${leftControl} ${pulledY}, ${segmentPullX} ${pulledY}`,
                    `C ${rightControl} ${pulledY}, ${rightControl} ${baseline}, ${rightEdge} ${baseline}`,
                    `L ${width} ${baseline}`,
                ].join(" "));
            });
        }
        function stopSpring() {
            if (animationFrame)
                cancelAnimationFrame(animationFrame);
            animationFrame = 0;
        }
        function pullLine(clientX, clientY, direction, strength) {
            if (reducedMotion.matches) { draw(); return; }
            stopSpring();
            const rects = lineRects();
            if (!rects.length)
                return;
            activeSegment = rects.reduce((closestIndex, rect, index) => {
                const closest = rects[closestIndex];
                const distance = Math.abs(clientY - (rect.top + rect.bottom) / 2);
                const closestDistance = Math.abs(clientY - (closest.top + closest.bottom) / 2);
                return distance < closestDistance ? index : closestIndex;
            }, 0);
            const bounds = rects[activeSegment];
            pullX = clamp(clientX - bounds.left, 0, bounds.width);
            displacement = direction * strength;
            velocity = 0;
            draw();
        }
        function pullTowardMouse(event) {
            const rects = lineRects();
            if (!rects.length)
                return;
            const nearestRect = rects.reduce((closest, rect) => {
                const distance = Math.abs(event.clientY - (rect.top + rect.bottom) / 2);
                const closestDistance = Math.abs(event.clientY - (closest.top + closest.bottom) / 2);
                return distance < closestDistance ? rect : closest;
            });
            const movement = previousMouseY === null ? event.movementY : event.clientY - previousMouseY;
            if (Math.abs(movement) > 0.15)
                mouseDirection = Math.sign(movement);
            else if (previousMouseY === null)
                mouseDirection = event.clientY > (nearestRect.top + nearestRect.bottom) / 2 ? -1 : 1;
            previousMouseY = event.clientY;
            const strength = clamp(10 + Math.abs(movement) * 1.35, 10, 18);
            pullLine(event.clientX, event.clientY, mouseDirection, strength);
        }
        function springBack() {
            stopSpring();
            if (reducedMotion.matches) { displacement = 0; velocity = 0; draw(); return; }
            let previousTime = performance.now();
            function settle(currentTime) {
                const elapsed = Math.min((currentTime - previousTime) / 1000, 0.032);
                previousTime = currentTime;
                const acceleration = -280 * displacement - 10.5 * velocity;
                velocity += acceleration * elapsed;
                displacement += velocity * elapsed;
                draw();
                if (Math.abs(displacement) < 0.04 && Math.abs(velocity) < 0.08) {
                    displacement = 0;
                    velocity = 0;
                    animationFrame = 0;
                    draw();
                    return;
                }
                animationFrame = requestAnimationFrame(settle);
            }
            animationFrame = requestAnimationFrame(settle);
        }
        function findTouch(touches) {
            if (activeTouchId === null)
                return null;
            for (let index = 0; index < touches.length; index += 1) {
                const touch = touches.item(index);
                if (touch?.identifier === activeTouchId)
                    return touch;
            }
            return null;
        }
        function startTouch(event) {
            if (activeTouchId !== null)
                return;
            const touch = event.changedTouches.item(0);
            if (!touch)
                return;
            activeTouchId = touch.identifier;
            previousTouchY = touch.clientY;
            touchStartX = touch.clientX;
            touchStartY = touch.clientY;
            touchMoved = false;
        }
        function moveTouch(event) {
            const touch = findTouch(event.touches);
            if (!touch)
                return;
            const movement = touch.clientY - previousTouchY;
            const totalTravel = Math.hypot(touch.clientX - touchStartX, touch.clientY - touchStartY);
            if (totalTravel > 5)
                touchMoved = true;
            if (Math.abs(movement) > 0.35) {
                const strength = clamp(8 + Math.abs(movement) * 1.15, 8, 15);
                pullLine(touch.clientX, touch.clientY, Math.sign(movement), strength);
            }
            previousTouchY = touch.clientY;
        }
        function endTouch(event) {
            const touch = findTouch(event.changedTouches);
            if (!touch)
                return;
            if (!touchMoved)
                pullLine(touch.clientX, touch.clientY, 1, 12);
            activeTouchId = null;
            springBack();
        }
        function leaveMouse() {
            previousMouseY = null;
            springBack();
        }
        const resizeObserver = new ResizeObserver(draw);
        const interactionTarget = mark.closest('a, button') || mark;
        resizeObserver.observe(mark);
        interactionTarget.addEventListener("mouseenter", pullTowardMouse);
        interactionTarget.addEventListener("mousemove", pullTowardMouse);
        interactionTarget.addEventListener("mouseleave", leaveMouse);
        interactionTarget.addEventListener('focus', draw);
        interactionTarget.addEventListener('blur', draw);
        mark.addEventListener("touchstart", startTouch, { passive: true });
        mark.addEventListener("touchmove", moveTouch, { passive: true });
        mark.addEventListener("touchend", endTouch, { passive: true });
        mark.addEventListener("touchcancel", endTouch, { passive: true });
        draw();
        return {
            draw,
            cleanup: () => {
                stopSpring();
                resizeObserver.disconnect();
                interactionTarget.removeEventListener("mouseenter", pullTowardMouse);
                interactionTarget.removeEventListener("mousemove", pullTowardMouse);
                interactionTarget.removeEventListener("mouseleave", leaveMouse);
                interactionTarget.removeEventListener('focus', draw);
                interactionTarget.removeEventListener('blur', draw);
                mark.removeEventListener("touchstart", startTouch);
                mark.removeEventListener("touchmove", moveTouch);
                mark.removeEventListener("touchend", endTouch);
                mark.removeEventListener("touchcancel", endTouch);
                segments.forEach(({ svg }) => svg.remove());
                segments.length = 0;
            },
        };
    }
    function syncUnderlines() {
        const marks = new Set(Array.from(effectRoot.querySelectorAll(selector)).filter((mark) =>
            !mark.matches('a, u') || (mark.textContent.trim() && !mark.querySelector('.elastic-underline, .elastic-nav-label'))
        ));
        marks.forEach((mark) => {
            if (!activeUnderlines.has(mark))
                activeUnderlines.set(mark, activate(mark));
        });
        activeUnderlines.forEach((effect, mark) => {
            if (!marks.has(mark)) {
                effect.cleanup();
                activeUnderlines.delete(mark);
            }
        });
    }
    syncUnderlines();
    const mutationObserver = new MutationObserver(() => {
        syncUnderlines();
        activeUnderlines.forEach((effect) => effect.draw());
    });
    mutationObserver.observe(effectRoot, { childList: true, subtree: true, characterData: true });
    const rootResizeObserver = new ResizeObserver(() => {
        activeUnderlines.forEach((effect) => effect.draw());
    });
    rootResizeObserver.observe(effectRoot);
    const redraw = () => { if (!disposed) activeUnderlines.forEach((effect) => effect.draw()); };
    effectRoot.addEventListener('toggle', redraw, true);
    effectRoot.addEventListener('scroll', redraw, true);
    document.fonts?.ready.then(redraw);
    return () => {
        disposed = true;
        effectRoot.removeEventListener('toggle', redraw, true);
        effectRoot.removeEventListener('scroll', redraw, true);
        mutationObserver.disconnect();
        rootResizeObserver.disconnect();
        activeUnderlines.forEach((effect) => effect.cleanup());
        activeUnderlines.clear();
        effectRoot.classList.remove("elastic-effect-root");
    };
}
