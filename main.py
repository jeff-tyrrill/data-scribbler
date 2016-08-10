#!/usr/bin/python3
from __future__ import print_function

import sys, json, os, random, string, re, time
from random import SystemRandom
from time import time

def debug(*objs):
    print("DEBUG: ", *objs, file=sys.stderr)

# http://stackoverflow.com/a/16090640
def natural_sort_key(s, _nsre=re.compile('([0-9]+)')):
    return [int(text) if text.isdigit() else text.lower()
            for text in re.split(_nsre, s)] 

# http://stackoverflow.com/a/1160227
def touch(fname, mode=0o666, dir_fd=None, **kwargs):
    flags = os.O_CREAT | os.O_APPEND
    with os.fdopen(os.open(fname, flags=flags, mode=mode, dir_fd=dir_fd)) as f:
        os.utime(f.fileno() if os.utime in os.supports_fd else fname,
            dir_fd=None if os.supports_fd else dir_fd, **kwargs)

# On the server, documents are stored in a 'data' folder by id.
# It is three levels deep based on the first two characters of the id, then the next two, then the rest of the id.
# We use .htaccess to block status.json, which is the only data-sensitive document. (To prevent finding the edit URL of a read-only document.)
# The client is designed to check latest.json directly (without hitting python), as this is rapid-fire queried for real-time collaboration.
# When the client sees the number in latest.json increment, it hits the API to ask for the actual changes.
# Each version is stored in a file like <versionnum>.json
# status.json is used to link info on read-only documents (both directions).
# Read-only IDs are stored with an empty folder except for latest.json and status.json, so the client-side interface is the same.
# (However, the client knows it is read-only so it can treat this appropriately in the UI.)

# assumes that the id is safe/validated
def generatePath(id, filename):
    return 'data/' + id[:2] + '/' + id[2:4] + '/' + id[4:] + '/' + filename;

# make sure that an id fits the expected format so we can safely use it to generate a path
def validateId(id):
    if not isinstance(id, str):
        return False
    return re.search('^[a-z0-9]{32}$', id);

# a function to determine whether we are requiring a 'fullStateAtoms' blurb for this save,
# which means we don't have to traverse further back to assemble the state.
def checkFullAtomsRequired(id, action):
    # if fullStateAtoms already included, then it's simple - we obviously don't need it
    if 'fullStateAtoms' in action and isinstance(action['fullStateAtoms'], dict) and action['fullStateAtoms']:
        return False
    
    # if we're jumping out of order (redo or undo action, basically), then we always need it
    if 'jumpTo' in action and action['jumpTo'] is not None:
        return True
    
    statusFile = open(generatePath(id, 'status.json'))
    status = json.loads(statusFile.read())
    statusFile.close()
    
    accumVersions = 0
    accumSize = 0
    files = os.listdir(generatePath(id, ''))
    files.sort(key=natural_sort_key, reverse=True)
    for versionFile in files:
        versionNumber = re.search('([0-9]+)\.json', versionFile)
        if versionNumber:
            versionFile = open(generatePath(id, versionFile))
            versionData = json.loads(versionFile.read())
            versionFile.close()
            
            if 'fullStateAtoms' in versionData:
                if not isinstance(versionData['fullStateAtoms'], dict) or not versionData['fullStateAtoms']:
                    accumVersions += 1
                    accumSize += len(json.dumps(versionData))
                    
                    # if we traverse back either 25 actions or 200KB worth of actions without finding a fullStateAtoms, then we need it
                    if accumVersions >= 25 or accumSize >= 204800:
                        return True
                else:
                    # but if we find a fullStateAtoms before reaching the threshhold above, then we don't need it
                    return False
    # shouldn't be reachable, but just in case, if we're not sure whether we need it or not, then say yes, for safety
    return True

# save the version blob
def saveVersion(id, action):
    statusFile = open(generatePath(id, 'status.json'))
    status = json.loads(statusFile.read())
    statusFile.close()
    
    if status['isReadOnly']:
        return False
    
    actionNum = str(action['id'])
    
    action['when'] = int(time()) * 1000
    
    if os.path.exists(generatePath(id, actionNum + '.json')):
        return False
    
    if os.path.exists(generatePath(id, 'temp-' + actionNum + '.json')):
        time.sleep(0.5 + SystemRandom().random() * 0.25)
        os.remove(generatePath(id, 'temp-' + actionNum + '.json'))
    
    try:
        # http://stackoverflow.com/a/1348073
        saveFileFd = os.open(generatePath(id, 'temp-' + actionNum + '.json'), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644) # different unix permissions than open() - may need to change depending on your server
        saveFile = os.fdopen(saveFileFd, 'w')
    except:
        return False
    
    saveFile.write(json.dumps(action))
    saveFile.flush()
    os.fsync(saveFile.fileno())
    saveFile.close()
    
    if os.path.exists(generatePath(id, actionNum + '.json')):
        os.remove(generatePath(id, 'temp-' + actionNum + '.json'))
        return False
    
    os.rename(generatePath(id, 'temp-' + actionNum + '.json'), generatePath(id, actionNum + '.json'))
    return True

# iterate through all the version blobs to find the latest one, and update the latest.json file accordingly
def updateLatest(id):
    statusFile = open(generatePath(id, 'status.json'))
    status = json.loads(statusFile.read())
    statusFile.close()
    updateLatestHelper(id, id)
    updateLatestHelper(id, status['readOnlyId'])

def updateLatestHelper(idForVersionFiles, idForLatestFile):
    largestVersion = -1
    for versionFile in os.listdir(generatePath(idForVersionFiles, '')):
        versionNumber = re.search('([0-9]+)\.json', versionFile)
        if versionNumber and int(versionNumber.group(1)) > largestVersion:
            largestVersion = int(versionNumber.group(1))
    
    currentVersion = -2
    try:
        latestFileOld = open(generatePath(idForLatestFile, 'latest.json'))
        currentVersion = json.loads(latestFileOld.read())
        latestFileOld.close()
    except:
        pass
    
    if currentVersion != largestVersion:
        saveStringWithRename(idForLatestFile, 'temp-', '.json', 'latest.json', json.dumps(largestVersion))

# a helper function to "atomically" (well, as close to that as is reasonably possible) save a file
def saveStringWithRename(id, tempPrefix, tempPostfix, finalName, contents):
    try:
        tempName = tempPrefix
        for i in range(32):
            tempName += SystemRandom().choice(string.ascii_lowercase)
        tempName += tempPostfix
        fileNew = open(generatePath(id, tempName), 'w')
        fileNew.write(contents)
        fileNew.flush()
        os.fsync(fileNew.fileno())
        fileNew.close()
        os.rename(generatePath(id, tempName), generatePath(id, finalName))
    except:
        pass
    

print("Content-Type: application/json\n\n")

error = False
try:
    data = json.loads(sys.stdin.read())
except:
    error = True

# 'function' is the predicate in the API input.
if error == False and 'function' not in data:
    error = True

# the server call for getting the latest data to the client side.
# used either for initial load, or for getting incremental updates from another user.
if error == False and data['function'] == 'update':
    if 'id' in data and 'latest' in data and validateId(data['id']) and isinstance(data['latest'], int) and os.path.exists(generatePath(data['id'], 'latest.json')):
        response = {'message': 'success', 'actions': []}
        
        statusFile = open(generatePath(data['id'], 'status.json'))
        status = json.loads(statusFile.read())
        statusFile.close()
        touch(generatePath(data['id'], 'status.json'))
        response['isReadOnly'] = status['isReadOnly']
        response['readOnlyId'] = status['readOnlyId']
        
        readId = data['id']
        if status['isReadOnly']:
            readId = status['editId']
        
        # we're not always going back to the very beginning when fetching the chain of updates, as it could be too much data.
        # we always at least go back to the last 'fullStateAtoms' blurb (out of technical necessity), and we also always go back 20 minutes.
        # once, traversing backward, we've found a 'fullStateAtoms' blurb AND we've gone back 20 minutes and 200KB of extra version data,
        # we keep going to the next 'fullStateAtoms' blurb and then call it good, and send all that back to the user.
        # if the user is not on an initial load, we send everything they explicitly asked for.
        
        reachedSizeBuffer = False
        reachedTimeBuffer = False
        reachedFirstFullAtoms = False
        
        goBackFurther = True
        accumSize = 0
        now = int(time()) * 1000
        files = os.listdir(generatePath(readId, ''))
        files.sort(key=natural_sort_key, reverse=True)
        for versionFile in files:
            if goBackFurther or data['latest'] != -1:
                versionNumber = re.search('([0-9]+)\.json', versionFile)
                if versionNumber and int(versionNumber.group(1)) > int(data['latest']):
                    versionFile = open(generatePath(readId, versionFile))
                    versionData = json.loads(versionFile.read())
                    versionFile.close()
                    
                    if 'fullStateAtoms' in versionData and isinstance(versionData['fullStateAtoms'], dict) and versionData['fullStateAtoms']:
                        if reachedFirstFullAtoms:
                            if reachedSizeBuffer and reachedTimeBuffer:
                                goBackFurther = False
                        reachedFirstFullAtoms = True
                    
                    if reachedFirstFullAtoms:
                        accumSize += len(json.dumps(versionData))
                        if accumSize > 204800:
                            reachedSizeBuffer = True
                        if now - versionData['when'] > 1200000:
                            reachedTimeBuffer = True
                    
                    response['actions'].append(versionData)
        
        print(json.dumps(response))
    else:
        error = True

# the server call for saving a version.
# there are intentional failure modes including:
# * 'rejected' (conflicts with another user's edit which got here first),
# * 'needFullAtoms' (we decide we need to break a chain of incremental updates and ask for the user's entire state in a blob),
# * 'tooBig' (exceeded a sanity check for being too big). the user experience here isn't great; it's mainly to protect the server.
#   however, in most real-world documents, the browser will crawl before actually seeing this error anyway.
if error == False and data['function'] == 'save':
    if ('id' in data) and ('action' in data) and isinstance(data['action'], dict) and ('id' in data['action']) and isinstance(data['action']['id'], int) and data['action']['id'] >= 0:
        if data['id'] == '':
            saveId = ''
            saveReadOnlyId = ''
            for i in range(32):
                saveId += SystemRandom().choice(string.ascii_lowercase + string.digits)
                saveReadOnlyId += SystemRandom().choice(string.ascii_lowercase + string.digits)
            
            try:
                os.makedirs('data/' + saveId[:2] + '/' + saveId[2:4] + '/' + saveId[4:])
                os.makedirs('data/' + saveReadOnlyId[:2] + '/' + saveReadOnlyId[2:4] + '/' + saveReadOnlyId[4:])
            except:
                pass
            
            # status.json is blocked with .htaccess so we can't find the "edit copy" of a read-only document
            saveStringWithRename(saveId, 'temp-', '.json', 'status.json', json.dumps({'isReadOnly': False, 'readOnlyId': saveReadOnlyId}))
            saveStringWithRename(saveReadOnlyId, 'temp-', '.json', 'status.json', json.dumps({'isReadOnly': True, 'readOnlyId': '', 'editId': saveId}))
            
            updateLatest(saveId)
        else:
            saveId = data['id']
        
        if validateId(saveId) and os.path.exists(generatePath(saveId, 'latest.json')):
            if len(json.dumps(data['action'])) > 524288:
                print("{\"message\": \"tooBig\"}")
            else:
                if checkFullAtomsRequired(saveId, data['action']):
                    print("{\"message\": \"needFullAtoms\"}")
                else:
                    saveResult = saveVersion(saveId, data['action'])
                    if not saveResult:
                        print("{\"message\": \"rejected\"}")
                    else:
                        updateLatest(saveId)
                        statusFile = open(generatePath(saveId, 'status.json'))
                        status = json.loads(statusFile.read())
                        statusFile.close()
                        readOnlyId = status['readOnlyId']
                        print(json.dumps({'message': 'success', 'id': saveId, 'readOnlyId': readOnlyId, 'when': int(time()) * 1000}))
        else:
            error = True
    else:
        error = True

if error == True:
    print("{\"message\": \"error\"}")
