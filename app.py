from flask import Flask, render_template, request, session, redirect, url_for
from flask_socketio import SocketIO, emit, join_room, leave_room
import random
import string
import math
import os

app = Flask(__name__)
# Use environment variable for SECRET_KEY in production, fallback to default for development
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'secret!')
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024 # 16MB max upload
socketio = SocketIO(app, 
                    max_http_buffer_size=1e8,  # Increase buffer for images
                    cors_allowed_origins="*")  # Configure CORS for production

lobbies = {}

def generate_lobby_code():
    return ''.join(random.choices(string.ascii_uppercase + string.digits, k=4))

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/lobby/<code_id>')
def lobby(code_id):
    if code_id not in lobbies:
        return redirect(url_for('index'))
    return render_template('lobby.html', code=code_id)

@socketio.on('connect')
def handle_connect():
    print(f"Client connected: {request.sid}")

@socketio.on('disconnect')
def handle_disconnect():
    print(f"Client disconnected: {request.sid}")
    disconnected_sid = request.sid
    
    for code, lobby_data in lobbies.items():
        if disconnected_sid in lobby_data['users']:
            username = lobby_data['users'][disconnected_sid]['username']
            is_host = (disconnected_sid == lobby_data['host'])
            
            del lobby_data['users'][disconnected_sid]
            
            # If in voting phase, check if this triggers a result
            if lobby_data['state'] == 'VOTING':
                active_users_count = len(lobby_data['users'])
                # Filter out the disconnected user from voted_users if present
                if disconnected_sid in lobby_data['voted_users']:
                    lobby_data['voted_users'].remove(disconnected_sid)
                
                if active_users_count > 0 and len(lobby_data['voted_users']) >= active_users_count:
                    calculate_results(code)
            
            emit('player_left', {'username': username, 'users': lobby_data['users']}, room=code)
            emit('update_lobby', lobby_data, room=code)
            
            # If the host disconnected, start a background task to check if they return
            if is_host:
                socketio.start_background_task(check_host_reconnect, code, disconnected_sid)
            
            break

@socketio.on('create_lobby')
def handle_create_lobby(data):
    username = data.get('username')
    code = generate_lobby_code()
    while code in lobbies:
        code = generate_lobby_code()
    
    lobbies[code] = {
        'host': request.sid,
        'host_name': username,
        'users': {request.sid: {'username': username, 'id': request.sid}},
        'candidates': [],
        'settings': {'topic': 'Anything', 'limit': 8},
        'state': 'LOBBY',
        'round_matches': [], # Current round matches queue
        'next_round_candidates': [], # Winners of current round
        'current_battle': None,
        'votes': {'A': 0, 'B': 0},
        'voted_users': []
    }
    join_room(code)
    emit('lobby_created', {'code': code, 'username': username}, room=request.sid)
    # Emit initial update
    emit('update_lobby', lobbies[code], room=code)

@socketio.on('join_lobby')
def handle_join_lobby(data):
    username = data.get('username')
    code = data.get('code')
    
    if code in lobbies:
        lobbies[code]['users'][request.sid] = {'username': username, 'id': request.sid}
        join_room(code)
        emit('joined_lobby', {'code': code, 'state': lobbies[code]}, room=request.sid)
        emit('update_lobby', lobbies[code], room=code)
    else:
        emit('error', {'message': 'Lobby not found'}, room=request.sid)

@socketio.on('rejoin_lobby')
def handle_rejoin(data):
    code = data.get('code')
    username = data.get('username')
    
    if code in lobbies:
        # If this user is the host (by name), update the host SID
        if lobbies[code].get('host_name') == username:
            lobbies[code]['host'] = request.sid

        # Update sid if username matches (simple reconnection logic)
        # Ideally we'd use a persistent user ID, but for this simple app, we just re-add/update
        lobbies[code]['users'][request.sid] = {'username': username, 'id': request.sid}
        join_room(code)
        
        # Send current state
        lobby_data = lobbies[code]
        
        # Determine what specific data to send based on state
        response = {'state': lobby_data['state'], 'settings': lobby_data['settings']}
        
        if lobby_data['state'] == 'SUBMISSION':
            emit('game_state_change', response)
            # Also send their submissions
            my_candidates = [c for c in lobby_data['candidates'] if c['owner'] == username]
            emit('submission_update', {'total': len(lobby_data['candidates']), 'my_candidates': my_candidates})
            
        elif lobby_data['state'] == 'VOTING':
            response['battle'] = lobby_data['current_battle']
            emit('game_state_change', response)
            
        elif lobby_data['state'] == 'RESULTS':
            emit('game_state_change', response)
            # Re-emit results if sitting on result screen
            if lobby_data.get('last_results'):
                emit('round_results', lobby_data['last_results'])
        
        else:
            emit('game_state_change', response)
            
        emit('update_lobby', lobby_data, room=code)

@socketio.on('start_game')
def handle_start_game(data):
    code = data.get('code')
    settings = data.get('settings')
    
    if code in lobbies and lobbies[code]['host'] == request.sid:
        lobbies[code]['settings'] = settings
        lobbies[code]['state'] = 'SUBMISSION'
        emit('game_state_change', {'state': 'SUBMISSION', 'settings': settings}, room=code)

@socketio.on('submit_candidate')
def handle_submission(data):
    code = data.get('code')
    name = data.get('name')
    image = data.get('image')
    
    if code in lobbies:
        lobby_data = lobbies[code]
        user = lobby_data['users'].get(request.sid)
        if user:
            username = user['username']
            
            # Check candidate limit
            limit = int(lobby_data['settings'].get('limit', 8))
            my_candidates = [c for c in lobby_data['candidates'] if c['owner'] == username]
            
            if len(my_candidates) >= limit:
                emit('error', {'message': f'You have reached the maximum limit of {limit} candidates.'}, room=request.sid)
                return
            
            candidate = {
                'id': len(lobby_data['candidates']),
                'name': name,
                'image': image,
                'owner': username
            }
            lobby_data['candidates'].append(candidate)
            
            # Broadcast count update
            my_candidates = [c for c in lobby_data['candidates'] if c['owner'] == username]
            
            # Send specific update to the submitter
            emit('submission_update', {
                'total': len(lobby_data['candidates']),
                'my_candidates': my_candidates,
                'limit': limit
            }, room=request.sid)
            
            # Send global update about total count (optimally would be a separate event or just piggyback)
            # For simplicity, we might just update everyone's total count?
            # Actually, main.js expects 'submission_update'. 
            # Let's emit a lighter weight event for others if needed, or just let them wait.
            # But the UI shows "Total Candidates", so we should broadcast total.
            for sid in lobby_data['users']:
                if sid != request.sid:
                    user_candidates = [c for c in lobby_data['candidates'] if c['owner'] == lobby_data['users'][sid]['username']]
                    emit('submission_update', {
                        'total': len(lobby_data['candidates']),
                        'my_candidates': user_candidates,
                        'limit': limit
                    }, room=sid)

@socketio.on('delete_candidate')
def handle_delete_candidate(data):
    code = data.get('code')
    candidate_id = data.get('candidate_id')
    
    if code in lobbies:
        lobby_data = lobbies[code]
        user = lobby_data['users'].get(request.sid)
        if user:
            username = user['username']
            
            # Find and remove the candidate if it belongs to this user
            lobby_data['candidates'] = [c for c in lobby_data['candidates'] if not (c['id'] == candidate_id and c['owner'] == username)]
            
            # Get updated user candidates
            limit = int(lobby_data['settings'].get('limit', 8))
            my_candidates = [c for c in lobby_data['candidates'] if c['owner'] == username]
            
            # Send update to the user
            emit('submission_update', {
                'total': len(lobby_data['candidates']),
                'my_candidates': my_candidates,
                'limit': limit
            }, room=request.sid)
            
            # Update others
            for sid in lobby_data['users']:
                if sid != request.sid:
                    user_candidates = [c for c in lobby_data['candidates'] if c['owner'] == lobby_data['users'][sid]['username']]
                    emit('submission_update', {
                        'total': len(lobby_data['candidates']),
                        'my_candidates': user_candidates,
                        'limit': limit
                    }, room=sid)

@socketio.on('finalize_submissions')
def handle_finalize(data):
    code = data.get('code')
    if code in lobbies and lobbies[code]['host'] == request.sid:
        lobby_data = lobbies[code]
        candidates = lobby_data['candidates']
        user_count = len(lobby_data['users'])
        limit = int(lobby_data['settings'].get('limit', 8))
        
        # Check if we have at least 2 candidates total
        if len(candidates) < 2:
            emit('error', {'message': 'Need at least 2 candidates to start voting. Please add more candidates!'}, room=request.sid)
            return
        
        # Check if each user has submitted EXACTLY the required number of candidates
        for sid, user_info in lobby_data['users'].items():
            username = user_info['username']
            user_candidates = [c for c in candidates if c['owner'] == username]
            if len(user_candidates) < limit:
                emit('error', {'message': f'Player {username} has only submitted {len(user_candidates)} out of {limit} required candidates!'}, room=request.sid)
                return
            elif len(user_candidates) > limit:
                emit('error', {'message': f'Player {username} has submitted {len(user_candidates)} candidates but only {limit} are allowed!'}, room=request.sid)
                return
            
        random.shuffle(candidates)
        
        # Create matches
        matches = []
        # If odd, one gets a bye (goes straight to next round winners)
        # We'll just handle pairs.
        
        i = 0
        while i < len(candidates) - 1:
            matches.append({
                'candidate_a': candidates[i],
                'candidate_b': candidates[i+1]
            })
            i += 2
        
        if i < len(candidates):
            # One left over. Auto-advance to next round.
            lobby_data['next_round_candidates'].append(candidates[i])
            
        lobby_data['round_matches'] = matches
        lobby_data['state'] = 'VOTING'
        
        start_next_battle(code)

def start_next_battle(code):
    lobby_data = lobbies[code]
    
    if not lobby_data['round_matches']:
        # Round over
        if len(lobby_data['next_round_candidates']) == 1 and not lobby_data['round_matches']:
            # Champion!
            winner = lobby_data['next_round_candidates'][0]
            lobby_data['state'] = 'CHAMPION'
            emit('game_over', {'winner': winner}, room=code)
            emit('game_state_change', {'state': 'CHAMPION'}, room=code)
            return
        else:
            # Prepare next round
            candidates = lobby_data['next_round_candidates']
            lobby_data['next_round_candidates'] = []
            
            # If only 1 candidate somehow (should be caught above), or 0?
            if len(candidates) < 2:
                # Should have been champion.
                pass
                
            random.shuffle(candidates)
            matches = []
            i = 0
            while i < len(candidates) - 1:
                matches.append({
                    'candidate_a': candidates[i],
                    'candidate_b': candidates[i+1]
                })
                i += 2
            
            if i < len(candidates):
                lobby_data['next_round_candidates'].append(candidates[i])
            
            lobby_data['round_matches'] = matches
            
            if not matches:
                # This might happen if we had 1 person left over and they are now the winner
                if len(lobby_data['next_round_candidates']) == 1:
                    winner = lobby_data['next_round_candidates'][0]
                    lobby_data['state'] = 'CHAMPION'
                    emit('game_over', {'winner': winner}, room=code)
                    emit('game_state_change', {'state': 'CHAMPION'}, room=code)
                    return

    # Pop next match
    current_match = lobby_data['round_matches'].pop(0)
    lobby_data['current_battle'] = current_match
    lobby_data['votes'] = {'A': 0, 'B': 0}
    lobby_data['voted_users'] = []
    
    emit('new_round', current_match, room=code)
    emit('game_state_change', {'state': 'VOTING', 'battle': current_match}, room=code)

@socketio.on('cast_vote')
def handle_vote(data):
    code = data.get('code')
    choice = data.get('choice') # 'A' or 'B'
    
    if code in lobbies:
        lobby_data = lobbies[code]
        if request.sid not in lobby_data['voted_users']:
            lobby_data['voted_users'].append(request.sid)
            if choice in ['A', 'B']:
                lobby_data['votes'][choice] += 1
            
            # Check if everyone voted (optional auto-progression)
            # For now, let's wait for the host to click "Next" OR show results automatically if all voted?
            # User requirement: "Once a winner is selected after all people have voted, show the statistics"
            # So we should auto-show results if everyone voted.
            
            active_users_count = len(lobby_data['users'])
            if len(lobby_data['voted_users']) >= active_users_count:
                calculate_results(code)

@socketio.on('next_round')
def handle_next_round(data):
    code = data.get('code')
    if code in lobbies and lobbies[code]['host'] == request.sid:
        start_next_battle(code)

def check_host_reconnect(code, old_host_sid):
    """Wait for 5 seconds to see if the host reconnects. If not, close the lobby."""
    socketio.sleep(5)  # Grace period for reconnection (e.g., page refresh)
    
    # Check if lobby still exists and if the host has changed their SID (reconnected)
    if code in lobbies:
        current_host_sid = lobbies[code]['host']
        
        # If the host SID is still the old one (nobody reconnected as host), close the lobby
        if current_host_sid == old_host_sid:
            print(f"Host did not reconnect to lobby {code}. Closing lobby.")
            
            # Notify all remaining users that the lobby is closed
            socketio.emit('lobby_closed', room=code)
            
            # Remove the lobby from the server
            del lobbies[code]
        else:
            print(f"Host reconnected to lobby {code} with new SID: {current_host_sid}")

def calculate_results(code):
    lobby_data = lobbies[code]
    votes_a = lobby_data['votes']['A']
    votes_b = lobby_data['votes']['B']
    
    battle = lobby_data['current_battle']
    
    # Tie-breaker: Random
    if votes_a == votes_b:
        winner_key = random.choice(['A', 'B'])
    else:
        winner_key = 'A' if votes_a > votes_b else 'B'
        
    winner = battle['candidate_a'] if winner_key == 'A' else battle['candidate_b']
    lobby_data['next_round_candidates'].append(winner)
    
    lobby_data['state'] = 'RESULTS'
    
    results = {
        'candidate_a': battle['candidate_a'],
        'candidate_b': battle['candidate_b'],
        'votes_a': votes_a,
        'votes_b': votes_b,
        'winner': winner
    }
    lobby_data['last_results'] = results
    
    emit('round_results', results, room=code)
    emit('game_state_change', {'state': 'RESULTS'}, room=code)

if __name__ == '__main__':
    socketio.run(app, debug=True, host='0.0.0.0', port=5000)
