const socket = io('https://rankfight.onrender.com');
let currentUser = '';
let isHost = false;
let currentLobby = '';
let submissionLimit = 8;

// DOM Elements
const views = {
    lobby: document.getElementById('view-lobby'),
    submission: document.getElementById('view-submission'),
    voting: document.getElementById('view-voting'),
    results: document.getElementById('view-results'),
    champion: document.getElementById('view-champion')
};

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
    // Check if we are on the landing page or lobby page
    if (document.querySelector('.landing-page')) {
        setupLandingPage();
    } else if (document.getElementById('game-app')) {
        setupLobbyPage();
    }
});

function setupLandingPage() {
    const createBtn = document.getElementById('createBtn');
    const joinBtn = document.getElementById('joinBtn');
    const usernameInput = document.getElementById('username');
    const lobbyCodeInput = document.getElementById('lobbyCode');
    const errorMsg = document.getElementById('errorMsg');

    createBtn.addEventListener('click', () => {
        const username = usernameInput.value.trim();
        if (!username) {
            errorMsg.textContent = 'Please enter a username';
            return;
        }
        socket.emit('create_lobby', { username: username });
    });

    joinBtn.addEventListener('click', () => {
        const username = usernameInput.value.trim();
        const code = lobbyCodeInput.value.trim().toUpperCase();
        
        if (!username) {
            errorMsg.textContent = 'Please enter a username';
            return;
        }
        if (!code || code.length !== 4) {
            errorMsg.textContent = 'Please enter a valid 4-letter code';
            return;
        }
        socket.emit('join_lobby', { username: username, code: code });
    });

    socket.on('lobby_created', (data) => {
        sessionStorage.setItem('username', data.username);
        sessionStorage.setItem('isHost', 'true');
        window.location.href = `/lobby/${data.code}`;
    });

    socket.on('joined_lobby', (data) => {
        sessionStorage.setItem('username', document.getElementById('username').value.trim());
        sessionStorage.setItem('isHost', 'false');
        window.location.href = `/lobby/${data.code}`;
    });

    socket.on('error', (data) => {
        errorMsg.textContent = data.message;
    });
}

function setupLobbyPage() {
    currentUser = sessionStorage.getItem('username');
    isHost = sessionStorage.getItem('isHost') === 'true';
    currentLobby = document.getElementById('game-app').dataset.code;

    if (!currentUser) {
        window.location.href = '/';
        return;
    }

    document.getElementById('currentUser').textContent = currentUser;
    
    // Re-join logic for socket (since page refreshed)
    socket.emit('rejoin_lobby', { code: currentLobby, username: currentUser });

    setupHostControls();
    setupSubmissionHandlers();
    
    // Global socket listeners
    socket.on('update_lobby', updateLobbyUI);
    socket.on('game_state_change', handleStateChange);
    socket.on('submission_update', updateSubmissionStats);
    socket.on('new_round', setupBattle);
    socket.on('round_results', showResults);
    socket.on('game_over', showChampion);
    socket.on('error', (data) => alert(data.message));
    socket.on('lobby_closed', handleLobbyClosed);
}

function setupHostControls() {
    if (!isHost) return;

    document.querySelectorAll('.host-only').forEach(el => el.classList.remove('hidden'));
    document.querySelectorAll('span[id^="display"]').forEach(el => el.classList.add('hidden'));
    document.getElementById('waitingMsg').classList.add('hidden');

    // Start Competition Button
    document.getElementById('startBtn').addEventListener('click', () => {
        const topic = document.getElementById('inputTopic').value || 'Anything';
        const limit = parseInt(document.getElementById('inputLimit').value) || 8;
        
        // Validate limit
        if (limit < 1) {
            alert('Candidates per person must be at least 1!');
            return;
        }
        if (limit > 32) {
            alert('Candidates per person cannot exceed 32!');
            return;
        }
        
        socket.emit('start_game', { code: currentLobby, settings: { topic, limit } });
    });

    // Finish Submissions Button
    document.getElementById('finishSubmissionsBtn').addEventListener('click', () => {
        socket.emit('finalize_submissions', { code: currentLobby });
    });

    // Next Round Button
    document.getElementById('nextRoundBtn').addEventListener('click', () => {
        socket.emit('next_round', { code: currentLobby });
    });
}

// --- UI UPDATERS ---

function switchView(viewName) {
    Object.values(views).forEach(el => el.classList.add('hidden'));
    if (views[viewName]) views[viewName].classList.remove('hidden');
}

function handleStateChange(data) {
    console.log('State changed to:', data.state);
    switch (data.state) {
        case 'LOBBY':
            switchView('lobby');
            break;
        case 'SUBMISSION':
            switchView('submission');
            document.querySelector('.highlight-topic').textContent = data.settings.topic;
            // Store the submission limit
            submissionLimit = parseInt(data.settings.limit) || 8;
            document.getElementById('myLimit').textContent = submissionLimit;
            document.getElementById('requiredLimit').textContent = submissionLimit;
            break;
        case 'VOTING':
            switchView('voting');
            if (data.battle) setupBattle(data.battle);
            break;
        case 'RESULTS':
            switchView('results');
            break;
        case 'CHAMPION':
            switchView('champion');
            break;
    }
}

function updateLobbyUI(data) {
    // Update players list
    const list = document.getElementById('playersList');
    list.innerHTML = '';
    Object.values(data.users).forEach(u => {
        const li = document.createElement('li');
        li.textContent = u.username;
        list.appendChild(li);
    });
    document.getElementById('playerCount').textContent = Object.keys(data.users).length;

    // Update settings display for non-hosts
    if (!isHost) {
        document.getElementById('displayTopic').textContent = data.settings.topic;
        document.getElementById('displayLimit').textContent = data.settings.limit;
    }
}

// --- SUBMISSION LOGIC ---

function setupSubmissionHandlers() {
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');
    
    // Drag & Drop
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.add('dragover'), false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.remove('dragover'), false);
    });

    dropZone.addEventListener('drop', handleDrop, false);
    fileInput.addEventListener('change', handleFiles, false);
    
    // Paste
    document.addEventListener('paste', handlePaste);

    // Submit Button
    document.getElementById('submitCandidateBtn').addEventListener('click', submitCandidate);

    // Debug Button
    const debugBtn = document.getElementById('debugFillBtn');
    if (debugBtn) {
        debugBtn.addEventListener('click', () => {
            const randomColor = Math.floor(Math.random()*16777215).toString(16);
            const canvas = document.createElement('canvas');
            canvas.width = 200;
            canvas.height = 200;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#' + randomColor;
            ctx.fillRect(0, 0, 200, 200);
            ctx.fillStyle = '#ffffff';
            ctx.font = '30px Arial';
            ctx.fillText('TEST', 60, 110);
            
            const dataUrl = canvas.toDataURL();
            showPreview(dataUrl); // This sets currentImage
            
            document.getElementById('candidateName').value = 'Test Fighter ' + Math.floor(Math.random() * 1000);
            // Optional: Auto submit
            // submitCandidate(); 
        });
    }
}

function handleDrop(e) {
    const dt = e.dataTransfer;
    const files = dt.files;
    handleFiles({ target: { files: files } });
}

function handlePaste(e) {
    if (views.submission.classList.contains('hidden')) return;
    
    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    for (let index in items) {
        const item = items[index];
        if (item.kind === 'file') {
            const blob = item.getAsFile();
            const reader = new FileReader();
            reader.onload = (event) => {
                showPreview(event.target.result);
            };
            reader.readAsDataURL(blob);
        }
    }
}

function handleFiles(e) {
    const files = e.target.files;
    if (files && files[0]) {
        const reader = new FileReader();
        reader.onload = (event) => {
            showPreview(event.target.result);
        };
        reader.readAsDataURL(files[0]);
    }
}

let currentImage = null;

function showPreview(src) {
    currentImage = src;
    document.getElementById('imgPreview').src = src;
    document.getElementById('previewContainer').classList.remove('hidden');
    document.querySelector('.upload-content').classList.add('hidden');
}

window.clearImage = function() {
    currentImage = null;
    document.getElementById('fileInput').value = '';
    document.getElementById('previewContainer').classList.add('hidden');
    document.querySelector('.upload-content').classList.remove('hidden');
}

function submitCandidate() {
    const nameInput = document.getElementById('candidateName');
    const name = nameInput.value.trim();

    if (!name || !currentImage) {
        alert('Please provide both a name and an image.');
        return;
    }

    // Check if limit already reached
    const currentCount = parseInt(document.getElementById('myCount').textContent) || 0;
    if (currentCount >= submissionLimit) {
        alert(`You have reached the maximum limit of ${submissionLimit} candidates.`);
        return;
    }

    socket.emit('submit_candidate', {
        code: currentLobby,
        name: name,
        image: currentImage
    });

    // Clear form
    nameInput.value = '';
    clearImage();
}

function updateSubmissionStats(data) {
    document.getElementById('totalCandidates').textContent = data.total;
    
    const myList = document.getElementById('myCandidatesList');
    myList.innerHTML = '';
    
    data.my_candidates.forEach(c => {
        const li = document.createElement('div');
        li.className = 'candidate-item';
        li.innerHTML = `
            <img src="${c.image}" class="candidate-thumb">
            <p>${c.name}</p>
            <button class="btn-delete" onclick="deleteCandidate(${c.id})" title="Delete this candidate">×</button>
        `;
        myList.appendChild(li);
    });
    
    const myCount = data.my_candidates.length;
    document.getElementById('myCount').textContent = myCount;
    
    // Update limit if provided
    if (data.limit) {
        submissionLimit = parseInt(data.limit);
        document.getElementById('myLimit').textContent = submissionLimit;
    }
    
    // Disable submit button if limit reached
    const submitBtn = document.getElementById('submitCandidateBtn');
    const dropZone = document.getElementById('dropZone');
    const nameInput = document.getElementById('candidateName');
    
    if (myCount >= submissionLimit) {
        submitBtn.disabled = true;
        submitBtn.textContent = `Complete (${myCount}/${submissionLimit})`;
        submitBtn.style.backgroundColor = '#27ae60';
        dropZone.style.opacity = '0.5';
        dropZone.style.pointerEvents = 'none';
        nameInput.disabled = true;
    } else {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit';
        submitBtn.style.backgroundColor = '';
        dropZone.style.opacity = '1';
        dropZone.style.pointerEvents = 'auto';
        nameInput.disabled = false;
    }
}

window.deleteCandidate = function(candidateId) {
    if (confirm('Are you sure you want to delete this candidate?')) {
        socket.emit('delete_candidate', {
            code: currentLobby,
            candidate_id: candidateId
        });
    }
}

// --- VOTING LOGIC ---

function setupBattle(battle) {
    if (!battle) return;
    
    switchView('voting');
    
    document.getElementById('voteStatusMsg').textContent = "Waiting for votes...";
    document.getElementById('nameA').textContent = battle.candidate_a.name;
    document.getElementById('imgA').src = battle.candidate_a.image;
    
    document.getElementById('nameB').textContent = battle.candidate_b.name;
    document.getElementById('imgB').src = battle.candidate_b.image;
    
    // Reset selection styling
    const cardA = document.getElementById('cardA');
    const cardB = document.getElementById('cardB');
    cardA.classList.remove('selected', 'animate-pop-in');
    cardB.classList.remove('selected', 'animate-pop-in');
    
    // Trigger reflow to restart animation
    void cardA.offsetWidth;
    void cardB.offsetWidth;
    
    // Add pop-in animation with slight delay for card B
    setTimeout(() => cardA.classList.add('animate-pop-in'), 50);
    setTimeout(() => cardB.classList.add('animate-pop-in'), 150);
    
    document.querySelector('.battle-arena').style.pointerEvents = 'auto';
}

window.vote = function(choice) {
    document.getElementById('voteStatusMsg').textContent = `You voted for ${choice === 'A' ? 'Left' : 'Right'}!`;
    document.querySelector('.battle-arena').style.pointerEvents = 'none';
    document.getElementById(`card${choice}`).classList.add('selected');
    
    socket.emit('cast_vote', {
        code: currentLobby,
        choice: choice
    });
}

function showResults(data) {
    const a = data.candidate_a;
    const b = data.candidate_b;
    const total = data.votes_a + data.votes_b;
    
    const percA = total === 0 ? 0 : Math.round((data.votes_a / total) * 100);
    const percB = total === 0 ? 0 : Math.round((data.votes_b / total) * 100);
    
    // Step 1: Fade out the voting arena
    const battleArena = document.querySelector('.battle-arena');
    const voteStatus = document.querySelector('.vote-status');
    battleArena.classList.add('animate-fade-out');
    if (voteStatus) voteStatus.classList.add('animate-fade-out');
    
    // Step 2: After fade out, switch views and prepare results
    setTimeout(() => {
        switchView('results');
        
        // Set up the results content
        document.getElementById('resNameA').textContent = a.name;
        document.getElementById('resNameB').textContent = b.name;
        document.getElementById('percA').textContent = `${percA}% (${data.votes_a})`;
        document.getElementById('percB').textContent = `${percB}% (${data.votes_b})`;
        document.getElementById('roundWinner').textContent = data.winner.name;
        
        // Reset bars to 0 width
        const barA = document.getElementById('barA');
        const barB = document.getElementById('barB');
        barA.style.transition = 'none';
        barB.style.transition = 'none';
        barA.style.width = '0%';
        barB.style.width = '0%';
        
        // Hide winner announcement initially
        const winnerAnnouncement = document.querySelector('.winner-announcement');
        winnerAnnouncement.style.opacity = '0';
        
        // Step 3: Apply fall animation to results display
        const resultsDisplay = document.querySelector('.results-display');
        resultsDisplay.classList.remove('animate-fall');
        void resultsDisplay.offsetWidth; // Trigger reflow
        resultsDisplay.classList.add('animate-fall');
        
        // Step 4: After results have "landed", animate the bars
        setTimeout(() => {
            barA.style.transition = 'width 1s ease-out';
            barB.style.transition = 'width 1s ease-out';
            barA.style.width = `${percA}%`;
            barB.style.width = `${percB}%`;
            
            // Step 5: Show winner announcement after bars are done
            setTimeout(() => {
                winnerAnnouncement.style.transition = 'opacity 0.5s ease-in';
                winnerAnnouncement.style.opacity = '1';
            }, 1000);
        }, 800); // Wait for fall animation to complete
        
        // Clean up voting arena animation classes
        battleArena.classList.remove('animate-fade-out');
        if (voteStatus) voteStatus.classList.remove('animate-fade-out');
    }, 300); // Wait for fade out animation
}

function showChampion(data) {
    switchView('champion');
    document.getElementById('championName').textContent = data.winner.name;
    document.getElementById('championImg').src = data.winner.image;
}

function handleLobbyClosed() {
    // Clear session storage and redirect to home page
    sessionStorage.removeItem('username');
    sessionStorage.removeItem('isHost');
    alert('The host has left the lobby. Returning to home page.');
    window.location.href = '/';
}
