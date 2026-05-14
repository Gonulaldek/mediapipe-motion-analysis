let videoElement;
let poseData = [];
let cameraObj;
let searchInput;
let searchResults;
let referenceMetrics = {
    currentAngle: null,
    minAngle: null,
    maxAngle: null,
    trackedSide: null
};

let handData = [];
let handMeta = [];
let lastHandTime = 0;
let inferBusy = false;
let handsInstance = null;

let handRepState = {
    left: { state: "OPEN", reps: 0, lastDisplaySide: null },
    right: { state: "OPEN", reps: 0, lastDisplaySide: null }
};
let handMetricEma = {};

const HAND_CONNECTIONS = [
    [0,1],[1,2],[2,3],[3,4],
    [0,5],[5,6],[6,7],[7,8],
    [5,9],[9,10],[10,11],[11,12],
    [9,13],[13,14],[14,15],[15,16],
    [13,17],[0,17],[17,18],[18,19],[19,20]
];
const FINGER_TIPS = [8, 12, 16, 20];
const PALM_BASE = [0, 5, 9, 13, 17];
const HAND_RESULT_MAX_AGE_MS = 150;

let sessionLog = [];
let currentSession = null;

function startSession(exerciseKey) {
    currentSession = {
        exercise: exerciseKey,
        startedAt: Date.now(),
        leftReps: 0,
        rightReps: 0,
        maxROM: -Infinity,
        minROM: Infinity
    };
}

function recordSessionMetric(value) {
    if (!currentSession || value === null || value === undefined || isNaN(value)) return;
    if (value > currentSession.maxROM) currentSession.maxROM = value;
    if (value < currentSession.minROM) currentSession.minROM = value;
}

function endSession() {
    if (!currentSession) return;
    const totalReps = currentSession.leftReps + currentSession.rightReps;
    if (totalReps === 0 || currentSession.maxROM === -Infinity) {
        currentSession = null;
        return;
    }
    sessionLog.push({
        date: new Date(currentSession.startedAt).toISOString(),
        exercise: currentSession.exercise,
        leftReps: currentSession.leftReps,
        rightReps: currentSession.rightReps,
        maxROM: Math.round(currentSession.maxROM * 10) / 10,
        minROM: Math.round(currentSession.minROM * 10) / 10,
        durationSec: Math.round((Date.now() - currentSession.startedAt) / 1000)
    });
    currentSession = null;
}

const EXERCISE_DB = {
    "bicep_curl": {
        name: "Bicep Curl",
        type: "ARMS",
        targetMin: 35,
        targetMax: 150,
        formTol: 25,
        refVideo: "videos/bicep_ref.mp4",
        description: "Doktor Tavsiyesi: Kolunuzu tam büktüğünüzde dirseğinizin gövdenizden ayrılmamasına dikkat edin. Omuz sabit kalmalı, sadece ön kol hareket etmelidir."
    },
    "squat": {
        name: "Squat",
        type: "LEGS",
        targetMin: 90,
        targetMax: 165,
        formTol: 30,
        refVideo: "videos/squat_ref.mp4",
        description: "Doktor Tavsiyesi: Dizlerinizin ayak parmak ucunu geçmemesine odaklanın. Sırtınızı dik tutun ve ağırlığı topuklarınıza verin."
    },
    "finger_extension": {
        name: "Parmak Ekstansiyon",
        type: "HANDS",
        metric: "PIP_ROM",
        targetMin: 90,
        targetMax: 170,
        repTriggerHigh: 160,
        repTriggerLow: 110,
        refVideo: "videos/finger_ext_ref.mp4",
        description: "Doktor Tavsiyesi: Avuç içiniz size dönük olacak şekilde elinizi tutun. Parmaklarınızı tek tek kıvırın, ardından tam ekstansiyona getirin. Hareket sırasında bileği sabit tutmaya çalışın. Yumruk yapmayın - sadece parmakları kıvırıp açın."
    },
    "finger_spread": {
        name: "Parmak Yana Aç-Kapa",
        type: "HANDS",
        metric: "FINGER_SPREAD",
        targetMin: 0,
        targetMax: 100,
        repTriggerHigh: 65,
        repTriggerLow: 25,
        refVideo: "videos/finger_spread_ref.mp4",
        description: "Doktor Tavsiyesi: Elinizi düz tutun, parmaklarınızı yana doğru olabildiğince açın, sonra yavaşça yan yana birleştirin. Bu egzersiz interosseöz kasları çalıştırır, başparmak hareketsiz kalsın."
    },
    "wrist_flexion": {
        name: "Bilek Aç-Kapa",
        type: "HANDS",
        metric: "WRIST_FIST_TILT",
        targetMin: 0,
        targetMax: 100,
        repTriggerHigh: 80,
        repTriggerLow: 35,
        refVideo: "videos/wrist_flexion_ref.mp4",
        description: "Doktor Tavsiyesi: Bu egzersiz iki aşamadan oluşur. Önce elinizi yumruk yapın (egzersiz %50 tamamlanır), ardından bileğinizi aşağı veya yukarı bükün (kalan %50 tamamlanır ve tekrar sayılır). Sadece yumruk yapmak veya sadece bilek bükmek tekrar saymaz - ikisi birlikte yapılmalı."
    }
};
let currentExe = { ...EXERCISE_DB["bicep_curl"] };

const VISIBILITY_THRESHOLD = 0.6;

let leftArmState = "ACIK", leftRepCount = 0, leftFormWarning = false;
let rightArmState = "ACIK", rightRepCount = 0, rightFormWarning = false;

const BODY_CONNECTIONS = [
    [11, 12], [11, 23], [12, 24], [23, 24],
    [23, 25], [25, 27], [27, 29], [29, 31], [27, 31],
    [24, 26], [26, 28], [28, 30], [30, 32], [28, 32],
    [15, 17], [15, 19], [15, 21], [17, 19],
    [16, 18], [16, 20], [16, 22], [18, 20]
];

function calculateAngle(a, b, c) {
    let radians = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(a.y - b.y, a.x - b.x);
    let angle = Math.abs(radians * 180.0 / Math.PI);
    return angle > 180.0 ? 360.0 - angle : angle;
}

function calculateVerticalDeviation(shoulder, elbow) {
    let radians = Math.atan2(elbow.y - shoulder.y, elbow.x - shoulder.x);
    let degrees = radians * (180 / Math.PI);
    return Math.abs(degrees - 90);
}

function resetExerciseState() {
    leftRepCount = 0;
    rightRepCount = 0;
    leftArmState = "ACIK";
    rightArmState = "ACIK";
    leftFormWarning = false;
    rightFormWarning = false;
    referenceMetrics.currentAngle = null;
    referenceMetrics.minAngle = null;
    referenceMetrics.maxAngle = null;
    referenceMetrics.trackedSide = null;
    handRepState.left.state = "OPEN";
    handRepState.left.reps = 0;
    handRepState.right.state = "OPEN";
    handRepState.right.reps = 0;
    handMetricEma = {};
    handData = [];
    updateReferenceAngleBadge(null, null);
}

function setup() {
    const mainCanvas = createCanvas(1000, 562);
    mainCanvas.id('mainCanvas');

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startCamera);
    } else {
        startCamera();
    }

    angleMode(DEGREES);
}

function startCamera() {
    videoElement = document.getElementById('videoElement');

    if (!videoElement) {
        console.error("videoElement bulunamadı!");
        return;
    }

    navigator.mediaDevices.getUserMedia({ video: { width: 1000, height: 562 } })
        .then(stream => {
            videoElement.srcObject = stream;
            initMediaPipe();
        })
        .catch(err => {
            console.error("Kamera erişim hatası:", err);
            alert("Lütfen kamera izni verin.");
        });
}

function initMediaPipe() {
    const pose = new Pose({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`
    });

    pose.setOptions({
        modelComplexity: 1,
        smoothLandmarks: true,
        enableSegmentation: false,
        minDetectionConfidence: 0.7,
        minTrackingConfidence: 0.7
    });

    pose.onResults((results) => {
        poseData = results.poseLandmarks || [];
    });

    const hands = new Hands({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
    });

    hands.setOptions({
        maxNumHands: 2,
        modelComplexity: 0,
        minDetectionConfidence: 0.6,
        minTrackingConfidence: 0.6
    });

    hands.onResults((results) => {
        handData = results.multiHandLandmarks || [];
        handMeta = results.multiHandedness || [];
        lastHandTime = performance.now();
    });

    handsInstance = hands;

    cameraObj = new Camera(videoElement, {
        onFrame: async () => {
            if (inferBusy) return;
            inferBusy = true;
            try {
                const jobs = [];
                if (currentExe.type === "HANDS") {
                    jobs.push(hands.send({ image: videoElement }));
                } else {
                    jobs.push(pose.send({ image: videoElement }));
                }
                await Promise.allSettled(jobs);
            } catch (err) {
                console.warn("Inference frame skipped:", err);
            } finally {
                inferBusy = false;
            }
        },
        width: 1000,
        height: 562
    });
    cameraObj.start();
}

function draw() {
    clear();

    if (currentExe.type === "HANDS") {
        drawHandExercise();
        return;
    }

    let uiElements = [];
    let progressBars = [];

    push();
    translate(width, 0);
    scale(-1, 1);

    if (videoElement && videoElement.readyState === videoElement.HAVE_ENOUGH_DATA) {
        drawingContext.globalAlpha = 0.4;
        drawingContext.drawImage(videoElement, 0, 0, width, height);
        drawingContext.globalAlpha = 1.0;
    } else {
        background(10, 15, 20);
    }

    if (poseData.length > 0) {
        let nose = poseData[0];
        let leftEar = poseData[7];
        let rightEar = poseData[8];

        if (nose && leftEar && rightEar && nose.visibility > VISIBILITY_THRESHOLD) {
            let nX = nose.x * width;
            let nY = nose.y * height;
            let earDist = dist(leftEar.x * width, leftEar.y * height, rightEar.x * width, rightEar.y * height);
            let headRadius = Math.max(earDist * 1.5, 60);

            noFill(); stroke(0, 150, 255, 200); strokeWeight(4);
            drawingContext.shadowBlur = 15; drawingContext.shadowColor = color(0, 150, 255);
            circle(nX, nY, headRadius);
        }

        strokeWeight(4); drawingContext.shadowBlur = 10; drawingContext.shadowColor = color(0, 150, 255);
        for (let i = 0; i < BODY_CONNECTIONS.length; i++) {
            let pA = poseData[BODY_CONNECTIONS[i][0]];
            let pB = poseData[BODY_CONNECTIONS[i][1]];
            if (pA && pB && pA.visibility > VISIBILITY_THRESHOLD && pB.visibility > VISIBILITY_THRESHOLD) {
                stroke(0, 150, 255, 180);
                line(pA.x * width, pA.y * height, pB.x * width, pB.y * height);
                noStroke(); fill(255, 200); circle(pA.x * width, pA.y * height, 6); circle(pB.x * width, pB.y * height, 6);
            }
        }

        let cameraAngle = detectCameraAngle(poseData);
        let readLeft = true;
        let readRight = true;

        let jL, jR;
        if(currentExe.type === "ARMS") {
            jL = [11, 13, 15];
            jR = [12, 14, 16];
        } else {
            jL = [23, 25, 27];
            jR = [24, 26, 28];
        }

        let pL1 = poseData[jL[0]], pL2 = poseData[jL[1]], pL3 = poseData[jL[2]];
        let pR1 = poseData[jR[0]], pR2 = poseData[jR[1]], pR3 = poseData[jR[2]];

        if (readLeft && pL1 && pL2 && pL3 && pL1.visibility > VISIBILITY_THRESHOLD && pL2.visibility > VISIBILITY_THRESHOLD && pL3.visibility > VISIBILITY_THRESHOLD) {
            let v1 = { x: pL1.x * width, y: pL1.y * height };
            let v2 = { x: pL2.x * width, y: pL2.y * height };
            let v3 = { x: pL3.x * width, y: pL3.y * height };

            let angleLeft = calculateAngle(v1, v2, v3);
            leftFormWarning = (currentExe.type === "ARMS") ? (calculateVerticalDeviation(v1, v2) > currentExe.formTol) : false;
            let leftProgress = constrain(map(angleLeft, currentExe.targetMax, currentExe.targetMin, 0, 100), 0, 100);

            if (angleLeft > currentExe.targetMax - 20) leftArmState = "ACIK";
            if (angleLeft < currentExe.targetMin + 20 && leftArmState === "ACIK" && !leftFormWarning) {
                leftArmState = "KAPALI";
                leftRepCount++;
                if (currentSession) currentSession.leftReps++;
            }
            recordSessionMetric(angleLeft);

            let leftColor = leftFormWarning ? color(255, 50, 50) : ((leftArmState === "KAPALI") ? color(0, 255, 100) : color(0, 255, 255));
            drawingContext.shadowColor = leftColor;
            strokeWeight(8); stroke(leftColor);
            line(v1.x, v1.y, v2.x, v2.y); line(v2.x, v2.y, v3.x, v3.y);

            uiElements.push({ text: Math.round(angleLeft) + "°", x: width - v2.x, y: v2.y - 45, col: leftColor });
            if (leftFormWarning) uiElements.push({ text: "FORM HATALI!", x: width - v2.x, y: v2.y + 40, col: color(255, 50, 50) });
            progressBars.push({ x: width - v2.x, y: v2.y, progress: leftProgress, col: leftColor });
        }

        if (readRight && pR1 && pR2 && pR3 && pR1.visibility > VISIBILITY_THRESHOLD && pR2.visibility > VISIBILITY_THRESHOLD && pR3.visibility > VISIBILITY_THRESHOLD) {
            let v1 = { x: pR1.x * width, y: pR1.y * height };
            let v2 = { x: pR2.x * width, y: pR2.y * height };
            let v3 = { x: pR3.x * width, y: pR3.y * height };

            let angleRight = calculateAngle(v1, v2, v3);
            rightFormWarning = (currentExe.type === "ARMS") ? (calculateVerticalDeviation(v1, v2) > currentExe.formTol) : false;
            let rightProgress = constrain(map(angleRight, currentExe.targetMax, currentExe.targetMin, 0, 100), 0, 100);

            if (angleRight > currentExe.targetMax - 20) rightArmState = "ACIK";
            if (angleRight < currentExe.targetMin + 20 && rightArmState === "ACIK" && !rightFormWarning) {
                rightArmState = "KAPALI";
                rightRepCount++;
                if (currentSession) currentSession.rightReps++;
            }
            recordSessionMetric(angleRight);

            let rightColor = rightFormWarning ? color(255, 50, 50) : ((rightArmState === "KAPALI") ? color(0, 255, 100) : color(255, 50, 200));
            drawingContext.shadowColor = rightColor;
            strokeWeight(8); stroke(rightColor);
            line(v1.x, v1.y, v2.x, v2.y); line(v2.x, v2.y, v3.x, v3.y);

            uiElements.push({ text: Math.round(angleRight) + "°", x: width - v2.x, y: v2.y - 45, col: rightColor });
            if (rightFormWarning) uiElements.push({ text: "FORM HATALI!", x: width - v2.x, y: v2.y + 40, col: color(255, 50, 50) });
            progressBars.push({ x: width - v2.x, y: v2.y, progress: rightProgress, col: rightColor });
        }

        
    } else {
        uiElements.push({ text: "Kullanıcı Aranıyor...", x: width/2, y: height/2, col: color(150) });
    }
    
    pop();

    drawingContext.shadowBlur = 0;
    
    noFill(); strokeWeight(6);
    for(let i=0; i<progressBars.length; i++) {
        let pb = progressBars[i];
        stroke(40, 150); arc(pb.x, pb.y, 80, 80, 0, 360);
        stroke(pb.col); 
        let endAngle = map(pb.progress, 0, 100, 0, 360);
        arc(pb.x, pb.y, 80, 80, -90, -90 + endAngle); 
    }

    textAlign(CENTER, CENTER); textStyle(BOLD);
    for (let i = 0; i < uiElements.length; i++) {
        fill(uiElements[i].col); noStroke(); textSize(uiElements[i].text.includes("FORM") ? 18 : 24);
        text(uiElements[i].text, uiElements[i].x, uiElements[i].y);
    }

    textAlign(LEFT, TOP); fill(15, 20, 25, 200); stroke(50); strokeWeight(2);
    rect(20, 20, 320, 135, 15);
    
    noStroke(); fill(255); textSize(20);
    text(currentExe.name.toUpperCase() + " ANALİZİ", 35, 35);
    
    fill(leftFormWarning ? color(255, 50, 50) : color(0, 255, 255)); textSize(26); text("SOL: " + leftRepCount, 35, 75);
    fill(rightFormWarning ? color(255, 50, 50) : color(255, 50, 200)); text("SAĞ: " + rightRepCount, 180, 75);
    fill(170, 220, 255); textSize(14); text("KAMERA: " + detectCameraAngle(poseData), 35, 115);
}

window.addEventListener('DOMContentLoaded', () => {
    const selectMenu = document.getElementById('exerciseSelect');
    const refVideo = document.getElementById('referenceVideo');
    searchInput = document.getElementById('searchInput');
    searchResults = document.getElementById('searchResults');

    if (searchInput) {
        searchInput.addEventListener('input', handleSearch);
    }

    document.addEventListener('click', (evt) => {
        if (searchResults && searchInput && !searchResults.contains(evt.target) && evt.target !== searchInput) {
            searchResults.style.display = 'none';
        }
    });

    if(selectMenu && refVideo) {
        const refVideoShell = refVideo.parentElement;

        function showVideoFallback(show) {
            if (!refVideoShell) return;
            let fallback = refVideoShell.querySelector('.ref-video-fallback');
            if (show) {
                refVideo.style.visibility = 'hidden';
                if (!fallback) {
                    fallback = document.createElement('div');
                    fallback.className = 'ref-video-fallback';
                    fallback.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;color:#76ffb2;background:rgba(2,8,7,0.78);font-size:11px;padding:14px;line-height:1.4;border-radius:0;';
                    fallback.innerHTML = '🎬<br><br>Bu egzersiz için<br>referans video<br>hazırlanmaktadır.<br><br>Yandaki açıklamayı<br>takip ediniz.';
                    refVideoShell.appendChild(fallback);
                }
                fallback.style.display = 'flex';
            } else {
                refVideo.style.visibility = 'visible';
                if (fallback) fallback.style.display = 'none';
            }
        }

        function loadRefVideo(src) {
            if (!src) {
                refVideo.removeAttribute('src');
                refVideo.load();
                showVideoFallback(true);
                return;
            }
            showVideoFallback(false);
            refVideo.src = src;
        }

        refVideo.onloadeddata = () => {
            showVideoFallback(false);
            let playPromise = refVideo.play();
            if (playPromise !== undefined) {
                playPromise.catch(() => {});
            }
        };

        refVideo.onerror = () => {
            showVideoFallback(true);
        };

        loadRefVideo(currentExe.refVideo);
        startSession(selectMenu.value);

        selectMenu.addEventListener('change', (e) => {
            endSession();
            currentExe = { ...EXERCISE_DB[e.target.value] };
            resetExerciseState();
            loadRefVideo(currentExe.refVideo);
            startSession(e.target.value);
            console.log("Sistem yeni harekete geçti:", currentExe.name);
            updateReportCard(e.target.value);
        });

        window.addEventListener('beforeunload', () => {
            endSession();
        });

        resetExerciseState();
        updateReportCard(selectMenu.value);
        if (searchInput) {
            searchInput.value = currentExe.name;
        }
        initMiniAI();

        function getActiveSessionSnapshot() {
            if (!currentSession) return null;
            const totalReps = currentSession.leftReps + currentSession.rightReps;
            if (totalReps === 0 || currentSession.maxROM === -Infinity) return null;
            return {
                date: new Date(currentSession.startedAt).toISOString(),
                exercise: currentSession.exercise,
                leftReps: currentSession.leftReps,
                rightReps: currentSession.rightReps,
                maxROM: Math.round(currentSession.maxROM * 10) / 10,
                minROM: Math.round(currentSession.minROM * 10) / 10,
                durationSec: Math.round((Date.now() - currentSession.startedAt) / 1000),
                inProgress: true
            };
        }

        function getAllSessions() {
            const all = [...sessionLog];
            const live = getActiveSessionSnapshot();
            if (live) all.push(live);
            return all;
        }

        function buildExportPayload() {
            return {
                user: "anonymous",
                exportDate: new Date().toISOString(),
                sessions: getAllSessions()
            };
        }

        window.MocapSystem = {
            getSessions: getAllSessions,
            getExportPayload: buildExportPayload,
            getCurrentExercise: () => currentExe ? currentExe.name : null
        };

        window.addEventListener('message', (event) => {
            if (!event.data || typeof event.data !== 'object') return;
            const { type, requestId } = event.data;
            if (type === 'MOCAP_GET_SESSIONS' && event.source) {
                event.source.postMessage({
                    type: 'MOCAP_SESSIONS_RESPONSE',
                    requestId: requestId || null,
                    payload: buildExportPayload()
                }, event.origin || '*');
            }
        });

        if (window.parent && window.parent !== window) {
            window.parent.postMessage({
                type: 'MOCAP_READY',
                version: '2.0'
            }, '*');
        }
    }
});


function getReferenceTrackingCandidate(landmarks) {
    const configs = currentExe.type === "ARMS"
        ? [
            { sideKey: "left", label: "Sol kol", joints: [11, 13, 15], segments: [[11, 13], [13, 15]] },
            { sideKey: "right", label: "Sağ kol", joints: [12, 14, 16], segments: [[12, 14], [14, 16]] }
        ]
        : [
            { sideKey: "left", label: "Sol bacak", joints: [23, 25, 27], segments: [[23, 25], [25, 27]] },
            { sideKey: "right", label: "Sağ bacak", joints: [24, 26, 28], segments: [[24, 26], [26, 28]] }
        ];

    let bestCandidate = null;
    let bestScore = -Infinity;

    for (const config of configs) {
        const points = config.joints.map(idx => landmarks[idx]);
        if (points.some(p => !p)) continue;

        const visibilityAvg = points.reduce((sum, p) => sum + (p.visibility || 0), 0) / points.length;
        if (visibilityAvg < 0.45) continue;

        const meanX = points.reduce((sum, p) => sum + p.x, 0) / points.length;
        const centerBonus = 1 - Math.abs(meanX - 0.5);
        const score = visibilityAvg * 0.8 + centerBonus * 0.2;

        if (score > bestScore) {
            bestScore = score;
            bestCandidate = { ...config, meanX };
        }
    }

    return bestCandidate;
}

function positionReferenceBadge(sideKey) {
    const badge = document.getElementById('refAngleBadge');
    if (!badge) return;
    badge.classList.remove('ref-angle-badge--left', 'ref-angle-badge--right');
    badge.classList.add(sideKey === 'right' ? 'ref-angle-badge--right' : 'ref-angle-badge--left');
}

function drawReferenceArrow(ctx, fromPoint, canvasWidth, canvasHeight, sideKey) {
    const target = sideKey === 'right'
        ? { x: canvasWidth - 84, y: canvasHeight - 26 }
        : { x: 84, y: canvasHeight - 26 };

    const arrowEnd = {
        x: target.x + (sideKey === 'right' ? -18 : 18),
        y: target.y - 12
    };

    ctx.save();
    ctx.strokeStyle = "rgba(118, 255, 178, 0.95)";
    ctx.fillStyle = "rgba(118, 255, 178, 0.95)";
    ctx.lineWidth = 2.6;
    ctx.setLineDash([7, 5]);
    ctx.beginPath();
    ctx.moveTo(fromPoint.x, fromPoint.y);
    ctx.lineTo(arrowEnd.x, arrowEnd.y);
    ctx.stroke();
    ctx.setLineDash([]);

    const angle = Math.atan2(target.y - arrowEnd.y, target.x - arrowEnd.x);
    const headLength = 12;
    ctx.beginPath();
    ctx.moveTo(target.x, target.y);
    ctx.lineTo(target.x - headLength * Math.cos(angle - Math.PI / 6), target.y - headLength * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(target.x - headLength * Math.cos(angle + Math.PI / 6), target.y - headLength * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}

function initMiniAI() {
    const refVideoEl = document.getElementById('referenceVideo');
    const refCanvas = document.getElementById('refCanvas');
    const refCtx = refCanvas ? refCanvas.getContext('2d') : null;
    let refPoseData = [];
    let isRefProcessing = false;

    if (!refVideoEl || !refCanvas || !refCtx) {
        console.warn("Referans video overlay bileşenleri eksik.");
        return;
    }

    const syncRefCanvasSize = () => {
        if (refVideoEl.videoWidth > 0 && refVideoEl.videoHeight > 0) {
            refCanvas.width = refVideoEl.videoWidth;
            refCanvas.height = refVideoEl.videoHeight;
        }
    };

    const refPose = new Pose({ locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${f}` });
    refPose.setOptions({ modelComplexity: 0, smoothLandmarks: true, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });

    refPose.onResults((results) => {
        refPoseData = results.poseLandmarks || [];
        drawReferenceOverlay();
    });

    async function processReferenceVideo() {
        if (currentExe.type === "HANDS") {
            refCtx.clearRect(0, 0, refCanvas.width, refCanvas.height);
            updateReferenceAngleBadge(null, null);
            if (isRefProcessing) {
                requestAnimationFrame(processReferenceVideo);
            }
            return;
        }
        if (!refVideoEl.paused && !refVideoEl.ended && refVideoEl.readyState >= 2 && refVideoEl.videoWidth > 0 && refVideoEl.videoHeight > 0) {
            try {
                await refPose.send({ image: refVideoEl });
            } catch (err) {
                console.warn("Referans overlay kare atladı:", err);
            }
        }
        if (isRefProcessing) {
            requestAnimationFrame(processReferenceVideo);
        }
    }

    refVideoEl.addEventListener('loadedmetadata', syncRefCanvasSize);
    refVideoEl.addEventListener('play', () => {
        syncRefCanvasSize();
        if (!isRefProcessing) {
            isRefProcessing = true;
            processReferenceVideo();
        }
    });

    refVideoEl.addEventListener('pause', () => {
        isRefProcessing = false;
    });

    function drawReferenceOverlay() {
        refCtx.clearRect(0, 0, refCanvas.width, refCanvas.height);

        if (refPoseData.length === 0) {
            updateReferenceAngleBadge(null);
            return;
        }

        refCtx.lineWidth = 2.8;
        refCtx.strokeStyle = "rgba(118, 255, 178, 0.92)";
        refCtx.fillStyle = "rgba(118, 255, 178, 1)";
        refCtx.shadowBlur = 10;
        refCtx.shadowColor = "rgba(118, 255, 178, 0.75)";

        const tracked = getReferenceTrackingCandidate(refPoseData);

        if (!tracked) {
            referenceMetrics.trackedSide = null;
            updateReferenceAngleBadge(null, null);
            return;
        }

        positionReferenceBadge(tracked.sideKey);

        for (const [startIdx, endIdx] of tracked.segments) {
            const pA = refPoseData[startIdx];
            const pB = refPoseData[endIdx];
            if (pA && pB && pA.visibility > 0.5 && pB.visibility > 0.5) {
                const x1 = pA.x * refCanvas.width, y1 = pA.y * refCanvas.height;
                const x2 = pB.x * refCanvas.width, y2 = pB.y * refCanvas.height;
                refCtx.beginPath();
                refCtx.moveTo(x1, y1);
                refCtx.lineTo(x2, y2);
                refCtx.stroke();

                refCtx.beginPath();
                refCtx.arc(x1, y1, 3.2, 0, 2 * Math.PI);
                refCtx.fill();
                refCtx.beginPath();
                refCtx.arc(x2, y2, 3.2, 0, 2 * Math.PI);
                refCtx.fill();
            }
        }

        const [i1, i2, i3] = tracked.joints;
        const p1 = refPoseData[i1], p2 = refPoseData[i2], p3 = refPoseData[i3];

        if (p1 && p2 && p3 && p1.visibility > 0.5 && p2.visibility > 0.5 && p3.visibility > 0.5) {
            const v1 = { x: p1.x * refCanvas.width, y: p1.y * refCanvas.height };
            const v2 = { x: p2.x * refCanvas.width, y: p2.y * refCanvas.height };
            const v3 = { x: p3.x * refCanvas.width, y: p3.y * refCanvas.height };
            const currentRefAngle = calculateAngle(v1, v2, v3);

            referenceMetrics.currentAngle = currentRefAngle;
            referenceMetrics.minAngle = referenceMetrics.minAngle === null ? currentRefAngle : Math.min(referenceMetrics.minAngle, currentRefAngle);
            referenceMetrics.maxAngle = referenceMetrics.maxAngle === null ? currentRefAngle : Math.max(referenceMetrics.maxAngle, currentRefAngle);
            referenceMetrics.trackedSide = tracked.label;

            drawReferenceAngleArc(refCtx, v1, v2, v3, currentRefAngle);
            drawReferenceArrow(refCtx, v2, refCanvas.width, refCanvas.height, tracked.sideKey);
            updateReferenceAngleBadge(currentRefAngle, tracked.label);
        } else {
            referenceMetrics.trackedSide = null;
            updateReferenceAngleBadge(null, null);
        }
    }
}

function drawReferenceAngleArc(ctx, a, b, c, angleValue) {
    const radius = 18;
    const angleA = Math.atan2(a.y - b.y, a.x - b.x);
    const angleC = Math.atan2(c.y - b.y, c.x - b.x);

    ctx.save();
    ctx.beginPath();
    ctx.strokeStyle = "rgba(118, 255, 178, 0.95)";
    ctx.lineWidth = 3;
    ctx.arc(b.x, b.y, radius, angleA, angleC, false);
    ctx.stroke();

    ctx.fillStyle = "rgba(0, 0, 0, 0.78)";
    ctx.strokeStyle = "rgba(118, 255, 178, 0.98)";
    ctx.lineWidth = 1.8;
    if (typeof ctx.roundRect === 'function') {
        ctx.beginPath();
        ctx.roundRect(b.x - 28, b.y - 38, 56, 26, 8);
        ctx.fill();
        ctx.stroke();
    } else {
        ctx.fillRect(b.x - 28, b.y - 38, 56, 26);
        ctx.strokeRect(b.x - 28, b.y - 38, 56, 26);
    }

    ctx.fillStyle = "rgba(118, 255, 178, 1)";
    ctx.font = "bold 15px Segoe UI";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`${Math.round(angleValue)}°`, b.x, b.y - 25);
    ctx.restore();
}

function updateReferenceAngleBadge(angle, trackedLabel) {
    const badgeValue = document.getElementById("refAngleBadgeValue");
    if (badgeValue) {
        badgeValue.textContent = angle === null ? "--°" : `${Math.round(angle)}°`;
    }

    const inlineValue = document.getElementById('refAngleInline');
    if (inlineValue) {
        inlineValue.textContent = angle === null ? '--°' : `${Math.round(angle)}°`;
    }

    const trackedSide = document.getElementById('refTrackedSide');
    if (trackedSide) {
        trackedSide.textContent = trackedLabel || 'Taraf algılanıyor...';
    }
}

function detectCameraAngle(poseData) {
    if (!poseData || poseData.length === 0) return "UNKNOWN";

    let lShoulder = poseData[11];
    let rShoulder = poseData[12];
    let lHip = poseData[23];
    let rHip = poseData[24];

    if (!lShoulder || !rShoulder) return "UNKNOWN";
    if (lShoulder.visibility < 0.3 && rShoulder.visibility < 0.3) return "UNKNOWN";

    let shoulderDiff = Math.abs(lShoulder.x - rShoulder.x);
    let hipDiff = (lHip && rHip && lHip.visibility > 0.3 && rHip.visibility > 0.3)
        ? Math.abs(lHip.x - rHip.x)
        : shoulderDiff;

    let avgDiff = (shoulderDiff + hipDiff) / 2;

    if (avgDiff > 0.25) {
        return "FRONTAL";
    } else if (lShoulder.x > rShoulder.x) {
        return "RIGHT_PROFILE";
    } else {
        return "LEFT_PROFILE";
    }
}

function handleSearch(e) {
    const term = e.target.value.toLowerCase().trim();
    const resultsDiv = document.getElementById('searchResults');
    resultsDiv.innerHTML = '';

    if (term.length < 2) {
        resultsDiv.style.display = 'none';
        return;
    }

    const matches = Object.keys(EXERCISE_DB).filter(key =>
        EXERCISE_DB[key].name.toLowerCase().includes(term)
    );

    if (matches.length > 0) {
        matches.forEach(key => {
            const item = document.createElement('div');
            item.className = 'search-result-item';

            let zoneLabel;
            if (EXERCISE_DB[key].type === 'LEGS') zoneLabel = 'Bacak analizi';
            else if (EXERCISE_DB[key].type === 'HANDS') zoneLabel = 'El analizi';
            else zoneLabel = 'Kol analizi';
            item.innerHTML = `
                <div class="search-result-title">${EXERCISE_DB[key].name}</div>
                <div class="search-result-meta">${zoneLabel} · Referans video hazır</div>
            `;

            item.onclick = () => {
                const selectMenu = document.getElementById('exerciseSelect');
                if (selectMenu) {
                    selectMenu.value = key;
                    selectMenu.dispatchEvent(new Event('change'));
                }
                document.getElementById('searchInput').value = EXERCISE_DB[key].name;
                document.getElementById('searchResults').style.display = 'none';
            };

            resultsDiv.appendChild(item);
        });
        resultsDiv.style.display = 'block';
    } else {
        const empty = document.createElement('div');
        empty.className = 'search-result-item';
        empty.innerHTML = `
            <div class="search-result-title">Sonuç bulunamadı</div>
            <div class="search-result-meta">Farklı bir hareket adı deneyebilirsin.</div>
        `;
        empty.style.cursor = 'default';
        resultsDiv.appendChild(empty);
        resultsDiv.style.display = 'block';
    }
}

function updateReportCard(key) {
    const reportCard = document.getElementById('reportCard');
    const infoText = document.getElementById('infoText');
    const refVideo = document.getElementById('referenceVideo');

    if (!EXERCISE_DB[key]) return;

    if (refVideo) {
        refVideo.src = EXERCISE_DB[key].refVideo;
        refVideo.play().catch(() => {});
    }

    let bolgeAdi = "eklem";
    if (EXERCISE_DB[key].type === "LEGS") bolgeAdi = "bacak";
    else if (EXERCISE_DB[key].type === "ARMS") bolgeAdi = "kol";
    else if (EXERCISE_DB[key].type === "SHOULDERS") bolgeAdi = "omuz";
    else if (EXERCISE_DB[key].type === "HANDS") bolgeAdi = "el";

    const dbMin = EXERCISE_DB[key].targetMin;
    const dbMax = EXERCISE_DB[key].targetMax;

    if (infoText) {
        if (EXERCISE_DB[key].type === "HANDS") {
            let hedefSatiri = "";
            if (EXERCISE_DB[key].metric === "PIP_ROM") {
                hedefSatiri = `Hedef: parmak orta eklem (PIP) açısı <strong>${dbMin}°</strong> (tam fleksiyon) ile <strong>${dbMax}°</strong> (tam ekstansiyon) arasında dolaşmalı.`;
            } else if (EXERCISE_DB[key].metric === "FINGER_SPREAD") {
                hedefSatiri = `Hedef: parmak yayılma yüzdesi <strong>0%</strong> (parmaklar bitişik) ile <strong>100%</strong> (tam yayılım) arasında dolaşmalı.`;
            } else if (EXERCISE_DB[key].metric === "WRIST_FIST_TILT") {
                hedefSatiri = `Hedef: önce yumruk yapın (yüzde <strong>%50</strong>'ye çıkar), ardından bileğinizi yukarı veya aşağı bükün (yüzde <strong>%100</strong>'e ulaşır ve tekrar sayılır).`;
            }
            infoText.innerHTML = `
                <span style="color: #00ff9d; font-weight: bold;">El Rehabilitasyon Egzersizi:</span> ${hedefSatiri}
                <span class="ref-angle-inline-wrap">
                    <span class="ref-angle-inline-label">Yandaki referans videoyu izleyerek hareketi yapın.</span>
                </span>
                <span style="color: #00ff9d; font-weight: bold;">Uzman Notu:</span> ${EXERCISE_DB[key].description}
            `;
        } else {
            infoText.innerHTML = `
                <span style="color: #00ff9d; font-weight: bold;">Önerilen ${bolgeAdi} açısı:</span> Olması gereken ${bolgeAdi} bükülme/açılma açısı tam olarak <strong>${dbMin}°</strong> ile <strong>${dbMax}°</strong> derece aralığındadır.
                <span class="ref-angle-inline-wrap">
                    <span class="ref-angle-inline-label">Referans videonun anlık açısı:</span>
                    <span id="refAngleInline" class="ref-angle-inline-value">--°</span>
                    <span id="refTrackedSide" class="ref-side-inline">Taraf algılanıyor...</span>
                </span>
                <span style="color: #00ff9d; font-weight: bold;">Uzman Notu:</span> ${EXERCISE_DB[key].description}
            `;
        }
    }

    if (reportCard) {
        reportCard.style.display = 'block';
    }

    updateReferenceAngleBadge(referenceMetrics.currentAngle, referenceMetrics.trackedSide);
}


function dist2D(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

function averagePoints(points) {
    const n = points.length;
    return {
        x: points.reduce((s, p) => s + p.x, 0) / n,
        y: points.reduce((s, p) => s + p.y, 0) / n
    };
}

function getPalmCenter(lm) {
    return averagePoints(PALM_BASE.map(i => lm[i]));
}

function getPalmScale(lm) {
    const palmWidth = dist2D(lm[5], lm[17]);
    const palmLength = dist2D(lm[0], lm[9]);
    return (palmWidth + palmLength) / 2;
}

function computeFistClosure(lm) {
    const center = getPalmCenter(lm);
    const scale = getPalmScale(lm) || 1;
    const meanDist = FINGER_TIPS
        .map(i => dist2D(lm[i], center))
        .reduce((a, b) => a + b, 0) / FINGER_TIPS.length;
    const norm = meanDist / scale;
    const OPEN_REF = 1.3;
    const CLOSED_REF = 0.45;
    const raw = 1 - ((norm - CLOSED_REF) / (OPEN_REF - CLOSED_REF));
    return Math.max(0, Math.min(100, raw * 100));
}

function computeMinPipAngle(lm) {
    const pipJoints = [[5,6,7], [9,10,11], [13,14,15], [17,18,19]];
    let minAngle = Infinity;
    for (const [a, b, c] of pipJoints) {
        const angle = calculateAngle(lm[a], lm[b], lm[c]);
        if (angle < minAngle) minAngle = angle;
    }
    return minAngle;
}

function computeFingerSpread(lm) {
    const fingerVecs = [[5, 8], [9, 12], [13, 16], [17, 20]].map(([base, tip]) => ({
        x: lm[tip].x - lm[base].x,
        y: lm[tip].y - lm[base].y
    }));

    let totalAngleDeg = 0;
    for (let i = 0; i < fingerVecs.length - 1; i++) {
        const v1 = fingerVecs[i];
        const v2 = fingerVecs[i + 1];
        const dot = v1.x * v2.x + v1.y * v2.y;
        const m1 = Math.hypot(v1.x, v1.y);
        const m2 = Math.hypot(v2.x, v2.y);
        if (m1 < 1e-6 || m2 < 1e-6) continue;
        const cosA = Math.max(-1, Math.min(1, dot / (m1 * m2)));
        totalAngleDeg += Math.acos(cosA) * 180 / Math.PI;
    }

    const OPEN_REF = 30;
    const CLOSED_REF = 6;
    const raw = (totalAngleDeg - CLOSED_REF) / (OPEN_REF - CLOSED_REF);
    return Math.max(0, Math.min(100, raw * 100));
}

function isThumbFolded(lm) {
    const palm = getPalmCenter(lm);
    const scale = getPalmScale(lm) || 1;
    const thumbTipDist = dist2D(lm[4], palm) / scale;
    return thumbTipDist < 0.85;
}

function computeWristTilt(lm) {
    const wrist = lm[0];
    const palmEnd = averagePoints([lm[5], lm[9], lm[13], lm[17]]);
    const dx = palmEnd.x - wrist.x;
    const dy = palmEnd.y - wrist.y;
    const angleRad = Math.atan2(-dy, Math.abs(dx));
    return angleRad * 180 / Math.PI;
}

function computeWristFistTilt(lm) {
    if (!lm || lm.length < 21) return 0;
    for (let i = 0; i < 21; i++) {
        if (!lm[i] || isNaN(lm[i].x) || isNaN(lm[i].y)) return 0;
    }
    const closure = computeFistClosure(lm);
    const tilt = computeWristTilt(lm);
    if (isNaN(closure) || isNaN(tilt)) return 0;

    const fistComponent = Math.min(50, (Math.min(closure, 80) / 80) * 50);
    const tiltMag = Math.min(35, Math.abs(tilt));
    const tiltComponent = closure > 50 ? (tiltMag / 35) * 50 : 0;
    return fistComponent + tiltComponent;
}

function drawForearmStub(lm, baseColor) {
    const wrist = lm[0];
    const midMcp = lm[9];
    const handDx = midMcp.x - wrist.x;
    const stubLength = 0.18;
    const stubDir = handDx >= 0 ? -1 : 1;
    const stubEndX = (wrist.x + stubDir * stubLength) * width;
    const stubEndY = wrist.y * height;
    const wristX = wrist.x * width;
    const wristY = wrist.y * height;

    drawingContext.shadowBlur = 6;
    drawingContext.shadowColor = baseColor;
    stroke(baseColor); strokeWeight(4);
    drawingContext.setLineDash([8, 6]);
    line(wristX, wristY, stubEndX, stubEndY);
    drawingContext.setLineDash([]);

    noStroke(); fill(baseColor);
    circle(stubEndX, stubEndY, 7);
    drawingContext.shadowBlur = 0;
}

function getDisplaySideStable(handLandmarks, previousSide) {
    const wrist = handLandmarks[0];
    const displayX = width - (wrist.x * width);
    const leftThreshold = width * 0.45;
    const rightThreshold = width * 0.55;

    if (previousSide === "left" && displayX < rightThreshold) return "left";
    if (previousSide === "right" && displayX > leftThreshold) return "right";
    return displayX < width / 2 ? "left" : "right";
}

function updateHandRep(sideKey, rawValue) {
    if (rawValue === null || rawValue === undefined || isNaN(rawValue)) return;
    recordSessionMetric(rawValue);
    const st = handRepState[sideKey];
    const high = currentExe.repTriggerHigh;
    const low = currentExe.repTriggerLow;
    const HIGH_IS_ACTION = ["FINGER_SPREAD", "WRIST_FIST_TILT"];
    const highIsAction = HIGH_IS_ACTION.includes(currentExe.metric);

    if (highIsAction) {
        if (st.state === "OPEN" && rawValue > high) {
            st.state = "CLOSED";
        } else if (st.state === "CLOSED" && rawValue < low) {
            st.state = "OPEN";
            st.reps += 1;
            if (currentSession) {
                if (sideKey === "left") currentSession.leftReps++;
                else currentSession.rightReps++;
            }
        }
    } else {
        if (st.state === "OPEN" && rawValue < low) {
            st.state = "CLOSED";
        } else if (st.state === "CLOSED" && rawValue > high) {
            st.state = "OPEN";
            st.reps += 1;
            if (currentSession) {
                if (sideKey === "left") currentSession.leftReps++;
                else currentSession.rightReps++;
            }
        }
    }
}

function drawHandSkeleton(lm, baseColor) {
    strokeWeight(3);
    drawingContext.shadowBlur = 8;
    drawingContext.shadowColor = baseColor;

    stroke(baseColor);
    for (const [a, b] of HAND_CONNECTIONS) {
        const pA = lm[a];
        const pB = lm[b];
        if (!pA || !pB) continue;
        line(pA.x * width, pA.y * height, pB.x * width, pB.y * height);
    }

    noStroke(); fill(255, 220);
    for (let i = 0; i < lm.length; i++) {
        circle(lm[i].x * width, lm[i].y * height, 5);
    }
    drawingContext.shadowBlur = 0;
}

function drawHandExercise() {
    let uiElements = [];
    let progressBars = [];

    push();
    translate(width, 0);
    scale(-1, 1);

    if (videoElement && videoElement.readyState === videoElement.HAVE_ENOUGH_DATA) {
        drawingContext.globalAlpha = 0.4;
        drawingContext.drawImage(videoElement, 0, 0, width, height);
        drawingContext.globalAlpha = 1.0;
    } else {
        background(10, 15, 20);
    }

    const handFresh = (performance.now() - lastHandTime) < HAND_RESULT_MAX_AGE_MS;

    if (handFresh && handData.length > 0) {
        const sideAssigned = { left: false, right: false };

        for (let h = 0; h < handData.length; h++) {
            const lm = handData[h];
            if (!lm || lm.length < 21) continue;

            const tentativeKey = h === 0 ? 'left' : 'right';
            const prevSide = handRepState[tentativeKey].lastDisplaySide;
            let sideKey = getDisplaySideStable(lm, prevSide);

            if (sideAssigned[sideKey]) {
                sideKey = sideKey === 'left' ? 'right' : 'left';
            }
            sideAssigned[sideKey] = true;
            handRepState[sideKey].lastDisplaySide = sideKey;

            let rawValue = null;
            let smoothValue = null;
            let displayLabel = "";

            if (currentExe.metric === "PIP_ROM") {
                rawValue = computeMinPipAngle(lm);
                if (isThumbFolded(lm)) {
                    rawValue = null;
                }
                const emaKey = sideKey + "_pip";
                if (rawValue !== null) {
                    handMetricEma[emaKey] = handMetricEma[emaKey] === undefined
                        ? rawValue
                        : 0.6 * rawValue + 0.4 * handMetricEma[emaKey];
                }
                smoothValue = handMetricEma[emaKey];
                displayLabel = smoothValue !== undefined ? Math.round(smoothValue) + "°" : "--°";
            } else if (currentExe.metric === "FINGER_SPREAD") {
                rawValue = computeFingerSpread(lm);
                const emaKey = sideKey + "_spread";
                handMetricEma[emaKey] = handMetricEma[emaKey] === undefined
                    ? rawValue
                    : 0.6 * rawValue + 0.4 * handMetricEma[emaKey];
                smoothValue = handMetricEma[emaKey];
                displayLabel = Math.round(smoothValue) + "%";
            } else if (currentExe.metric === "WRIST_FIST_TILT") {
                rawValue = computeWristFistTilt(lm);
                const emaKey = sideKey + "_wft";
                handMetricEma[emaKey] = handMetricEma[emaKey] === undefined
                    ? rawValue
                    : 0.6 * rawValue + 0.4 * handMetricEma[emaKey];
                smoothValue = handMetricEma[emaKey];
                displayLabel = Math.round(smoothValue) + "%";
            }

            updateHandRep(sideKey, rawValue);

            const inAction = handRepState[sideKey].state === "CLOSED";
            const baseColor = sideKey === "left"
                ? (inAction ? color(0, 255, 100) : color(0, 255, 255))
                : (inAction ? color(0, 255, 100) : color(255, 50, 200));

            if (currentExe.metric === "WRIST_FIST_TILT") {
                drawForearmStub(lm, baseColor);
            }
            drawHandSkeleton(lm, baseColor);

            let progressPercent;
            if (smoothValue === undefined || smoothValue === null) {
                progressPercent = 0;
            } else if (currentExe.metric === "FINGER_SPREAD" || currentExe.metric === "WRIST_FIST_TILT") {
                progressPercent = constrain(smoothValue, 0, 100);
            } else {
                progressPercent = constrain(map(smoothValue, currentExe.targetMax, currentExe.targetMin, 0, 100), 0, 100);
            }

            const palmC = getPalmCenter(lm);
            const px = palmC.x * width;
            const py = palmC.y * height;

            uiElements.push({ text: displayLabel, x: width - px, y: py - 60, col: baseColor });
            progressBars.push({ x: width - px, y: py, progress: progressPercent, col: baseColor });
        }
    } else {
        uiElements.push({ text: "El Aranıyor...", x: width/2, y: height/2, col: color(150) });
    }

    pop();

    drawingContext.shadowBlur = 0;
    noFill(); strokeWeight(6);
    for (let i = 0; i < progressBars.length; i++) {
        let pb = progressBars[i];
        stroke(40, 150); arc(pb.x, pb.y, 80, 80, 0, 360);
        stroke(pb.col);
        let endAngle = map(pb.progress, 0, 100, 0, 360);
        arc(pb.x, pb.y, 80, 80, -90, -90 + endAngle);
    }

    textAlign(CENTER, CENTER); textStyle(BOLD);
    for (let i = 0; i < uiElements.length; i++) {
        fill(uiElements[i].col); noStroke(); textSize(uiElements[i].text === "El Aranıyor..." ? 22 : 26);
        text(uiElements[i].text, uiElements[i].x, uiElements[i].y);
    }

    textAlign(LEFT, TOP); fill(15, 20, 25, 200); stroke(50); strokeWeight(2);
    rect(20, 20, 320, 135, 15);

    noStroke(); fill(255); textSize(20);
    text(currentExe.name.toUpperCase() + " ANALİZİ", 35, 35);

    fill(0, 255, 255); textSize(26); text("SOL: " + handRepState.left.reps, 35, 75);
    fill(255, 50, 200); text("SAĞ: " + handRepState.right.reps, 180, 75);
    fill(170, 220, 255); textSize(14); text("ELLER: " + handData.length + " algılandı", 35, 115);
}