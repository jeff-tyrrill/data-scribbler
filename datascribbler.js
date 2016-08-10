$(document).ready(function() {

// basic state
var atoms = { // state of the current version of the document that you're viewing
    '0': {
        id: '0',
        formula: 'list',
        args: [],
        type: 'list',
        data: [],
        isExpanded: true,
        isDirty: false,
        // isChanged: true,
        traversedYet: false
    }
};
var actionsHistory = {}; // the entire revision history of the document
var actionsHistoryPointer = -1; // id of the current display version ('action')
var maximumActionsHistoryId = -1; // the largest action id
var uiState = 'normal';
var wrapCollapsed = false; // whether long strings are truncated or not
var dataLinkIndex = {}; // a hack to help preserve expanded/collapsed state on collections a little bit (not perfect)

// column layout state - used for scrolling and animating columns (when the screen is too narrow to fit them all)
var columnFirst = 0;
var highestDepth = 0;
var previousWidth = 0;
var scrollLeftAllowed = false;
var scrollRightAllowed = false;
var timeOfLastColumnRecalculate = 0;
var inScrollAnimation = false;
var timeWhenAnimationFinishes;
var timeWhenAnimationStarts;
var scrollDirection; // 'left' or 'right'
var timeLastScrolledDragging = 0;

// other display state
var statusCenterDisplay = 0;
var tooltipHide;
var userNotices = []; // each value is object, in form: {element: $elem, when: 0}
var changeHighlight = {}; // key is atom id, value is time placed (number)

// move/dragging state
var $moveDraggingElement;
var $moveDraggingElementContainer;
var moveDraggingElementOffsetX;
var moveDraggingElementOffsetY;
var moveDraggingElementContainerOffsetX;
var moveDraggingElementContainerOffsetY;

// formula picker state
var formulaChoosingIsChange;
var formulaChoosingIsPrivate;
var formulaChoosingAtomId;
var formulaChoosingParentId;
var formulaChoosingParentPosition;
var formulaChoosingFormula;
var formulaChoosingAtomArgs;
var formulaChoosingTransformState;

// sync-related state
var isPrivate = false; // private mode - no data is sent to the server. all revision functionality still works in private mode.
var documentId = '';
var isReadOnly = false;
var readOnlyDocumentId = ''; // if we're viewing an edit document, then this is the id the server told us so we can share the link to the view-only document.
var lastTimeResetUpdateInterval = new Date().getTime(); // the update-checking interval gradually increases over time. this is the time of the last event that "resets" it to the lowest (fastest) checking interval.
var lastTimeUpdated = 0;
var inSaveCall = false;
var inUpdateCall = false;


// The basic data model:
// 
// Each permanent cell is called an "atom". Every atom has an "element", which is a visual cell in the UI.
// However, some elements do not have atoms. These non-atom elements include children of calculated atoms,
// and set members. Such elements cannot be the arguments of a formula.
// 
// The "formula" and "args" members are the stable attributes of an atom. They never change as the result
// of a recalculation. The "type" and "data" members are recalculated every cycle, and are volatile.
// 
// For literal data, the "formula" is one of the provided formulas for literal data types, and the data itself
// is stored in "args". For computation formulas, the "args" are usually references to other atoms, but for
// a few formula types, they are also user-specified and -editable strings. For explicit (not-computed) collections,
// the args are:
// * lists - references to the children atoms
// * dictiontaries - an array of objects, in the form {key: "key", value: value} where the keys are strings and
//   the values are refernences to the children atoms
// * sets - an array of explicit literal values (sets cannot hold collections, formulas, other atoms, etc.)
// data is a proprietary, ad-hoc data format that resembles JSON (but isn't quite) and stores the results of
// the calculated data and its children. all three collection types are JavaScript arrays (not objects, even dictionaries),
// with the 'collectionType' member indicating the type. "undefined" and "circular reference" are stored like:
// {specialType: "undefined"} and {specialType: "circularReference"}
// We cannot store them directly because we need to transit between JSON sometimes (to send to the server, etc.).
//
// Therefore, this application has two parallel data formats. One for the "args" portion of the atom, the other for
// the "data" portion. We have helper functions to translate between the two.
// 
// This is not the only possible data model that this application could have been designed with. It has
// advantages and disadvantages. The advantage is the simplicity in the constraint that atoms cannot be created
// or destroyed via transient calculation. The disadvantage is that computed elements cannot be referenced. This
// will be regarded as unintuitive and frustrating to many users and only makes any sense if you take some time
// to digest how the data model works.
// 
// Specifically, the existence of "sets" (unordered collections of unique values) as a third collection type
// significantly contributed to the complexity of this application and to its data model and implementation.
// A significant amount of logic needed extensive special casing to deal with sets, including but not only
// because of the departure from JSON. If I were to rebuild this application, I would probably no longer include sets.

//

// The basic data syncing model:
// 
// This application uses a surprisingly dumb "bent pipe" model to handle real-time collaborative data syncing.
// "Bent pipe" is a reference to old communications satellites that had very little computation logic in the satellite,
// and instead simply relay radio signals from a phone to a base station, which contains all the logic.
// 
// This is in contrast to much smarter communications satellites such as the Iridum network, which do extensive
// data processing on each satellite, and intelligently route data from satellite to satellite, so that a large network
// of satellites routes all of the data through a small number of base stations (which may only be within line of site
// of a small portion of the satellite network).
// 
// You may be thinking that the server must do extensive processing of things like resolving document conflicts,
// and so on. In fact, the server does very little. It mainly stores incremental differences sent by the client sight-unseen,
// and sends them to other clients upon request. Document versions ("actions") have a sequential identifier. If two
// clients send an action with the same identifier, the earlier one wins, and the second is rejected. The client,
// not server, then decides what to do with it.
// 
// Here is what the client decides to do when it loses in the race to save an action:
// It holds on to the unsaved changes. It then asks the server for the other user(s)'s changes. It then runs two simulations:
// One, with the remote actions performed first, and the local actions performed afterward. It serializes the state
// into a blob and holds on to it. The second simulation performs the local actions first, and the remote ones afterward.
// We look at the state blob for that one too. If the both state blobs match, then we declare the actions to be in harmony,
// and keep them. We adjust the sequential IDs of the local actions and attempt to re-save them to the server, just as if they
// had never been in conflict. (The server does not treat them any different, as the follow-up to a failed conflict, or anything
// like that.) However, if both state blobs don't match, or if we got an exception (or failures in a couple of other errors we
// check for), then the actions are regarded to be in conflict. We "accept" the remote actions (as we must, because the server
// blessed them), and discard the local actions, and display a brief note to the user that actions were in conflict and reverted.
//
// The "dumb pipe" model also means we don't validate remote user actions except as needed to prevent script injection, and
// to mitigate against errors that can happen if all users are legitimately using the UI.
// 
// Because edit access to a document basically lets you clobber everything anyway, it is not considered a bug or security vulnerability
// if users can submit actions which will permanently corrupt a document.
//
// It is only considered a bug or security vulnerability if a user can inject script to another user, or edit a read-only document
// (or obtain its ID).

var atomTemplate = {
    id: '',
    formula: '',
    args: [],
    type: '',
    data: null,
    isExpanded: true,
    isDirty: false,
    // isChanged: true, // not used for now, so every code reference to isChanged is commented. may be used for re-rendering optimization in the future
    traversedYet: false
};

var indentWidth = 24;

var uiStates = [
    'normal',
    'moveDragging',
    'formulaChoosing',
    'preload'
];

var types = [
    'string',
    'number',
    'boolean',
    'null',
    'undefined',
    'list',
    'set',
    'dictionary',
    'circularReference'
];

var formulaNames = {
    'literalString': 'string',
    'literalNumber': 'number',
    'literalBoolean': 'boolean',
    'literalNull': 'null',
    'literalUndefined': 'undefined',
    'list': 'list',
    'set': 'set',
    'dictionary': 'dictionary'
};

var formulas = {
    'noop':             {isComputed: false, hasAtomArguments: false, hasNonAtomArguments: false, minArguments: 0, maxArguments: 0,         allowedInSet: false, isCollection: false, description: ''},
    'literalString':    {isComputed: false, hasAtomArguments: false, hasNonAtomArguments: true,  minArguments: 1, maxArguments: 1,         allowedInSet: true,  isCollection: false, description: ''},
    'literalNumber':    {isComputed: false, hasAtomArguments: false, hasNonAtomArguments: true,  minArguments: 1, maxArguments: 1,         allowedInSet: true,  isCollection: false, description: ''},
    'literalBoolean':   {isComputed: false, hasAtomArguments: false, hasNonAtomArguments: true,  minArguments: 1, maxArguments: 1,         allowedInSet: true,  isCollection: false, description: ''},
    'literalNull':      {isComputed: false, hasAtomArguments: false, hasNonAtomArguments: false, minArguments: 0, maxArguments: 0,         allowedInSet: true,  isCollection: false, description: ''},
    'literalUndefined': {isComputed: false, hasAtomArguments: false, hasNonAtomArguments: false, minArguments: 0, maxArguments: 0,         allowedInSet: true,  isCollection: false, description: ''},
    'list':             {isComputed: false, hasAtomArguments: true,  hasNonAtomArguments: false, minArguments: 0, maxArguments: undefined, allowedInSet: false, isCollection: true, description: ''},
    'set':              {isComputed: false, hasAtomArguments: false, hasNonAtomArguments: true,  minArguments: 0, maxArguments: undefined, allowedInSet: false, isCollection: true, description: ''},
    'dictionary':       {isComputed: false, hasAtomArguments: false, hasNonAtomArguments: false, minArguments: 0, maxArguments: undefined, allowedInSet: false, isCollection: true, description: ''},
    'jsonPath':         {isComputed: true,  hasAtomArguments: true,  hasNonAtomArguments: true,  minArguments: 2, maxArguments: 2,         allowedInSet: false, isCollection: false, promptArguments: ['', 'Query:'], atomArguments: [0], description: 'List of results from a query on an element using the JSONPath query language', promptDescription: 'JSONPath is like XPath for JSON. Uses the JSONPath Plus implementation. Some complex filter scripts (implemented using the () or ?() syntax) are disabled, for security reasons.<br/><br/><a href="https://github.com/s3u/JSONPath" target="_blank">Documentation and reference</a>'},
    'generate':         {isComputed: true,  hasAtomArguments: true,  hasNonAtomArguments: true,  minArguments: 3, maxArguments: 3,         allowedInSet: false, isCollection: false, promptArguments: ['', '', 'Expression formula:'], atomArguments: [0, 1], description: 'Generate a list using a loop and arbitrary expression formula (first two arguments are start value (inclusive) and end value (exclusive))', promptDescription: 'Use @ for the iteration counter. Some complex formulas are not allowed, for security reasons. When using object literals, object keys must be quoted.'},
    'expression':       {isComputed: true,  hasAtomArguments: true,  hasNonAtomArguments: true,  minArguments: 2, maxArguments: 2,         allowedInSet: false, isCollection: false, promptArguments: ['', 'Expression formula:'], atomArguments: [0], description: 'Generate a list from a collection and an arbitrary expression formula', promptDescription: 'Use @ for the item value. Some complex formulas are not allowed, for security reasons. When using object literals, object keys must be quoted.'},
    'expressionDual':   {isComputed: true,  hasAtomArguments: true,  hasNonAtomArguments: true,  minArguments: 3, maxArguments: 3,         allowedInSet: false, isCollection: false, promptArguments: ['', '', 'Expression formula:'], atomArguments: [0, 1], description: 'Generate a list from two collections and an arbitrary expression formula', promptDescription: 'Use @ and # for the item values. Some complex formulas are not allowed, for security reasons. When using object literals, object keys must be quoted.'},
    'clone':            {isComputed: true,  hasAtomArguments: true,  hasNonAtomArguments: false, minArguments: 1, maxArguments: 1,         allowedInSet: false, isCollection: false, description: 'A recursive mirror of all elements'},
    'cloneShallow':     {isComputed: true,  hasAtomArguments: true,  hasNonAtomArguments: false, minArguments: 1, maxArguments: 1,         allowedInSet: false, isCollection: false, description: 'A mirror of all top-level elements, with collections empty'},
    'flatten':          {isComputed: true,  hasAtomArguments: true,  hasNonAtomArguments: false, minArguments: 1, maxArguments: 1,         allowedInSet: false, isCollection: false, description: 'A recursive mirror of all elements, flattened to a one-level deep array'},
    'count':            {isComputed: true,  hasAtomArguments: true,  hasNonAtomArguments: false, minArguments: 1, maxArguments: 1,         allowedInSet: false, isCollection: false, description: 'Number of sub-elements, measured recursively'},
    'smallest':         {isComputed: true,  hasAtomArguments: true,  hasNonAtomArguments: false, minArguments: 1, maxArguments: 1,         allowedInSet: false, isCollection: false, description: 'The smallest of all number-type elements'},
    'largest':          {isComputed: true,  hasAtomArguments: true,  hasNonAtomArguments: false, minArguments: 1, maxArguments: 1,         allowedInSet: false, isCollection: false, description: 'The largest of all number-type elements'},
    'mean':             {isComputed: true,  hasAtomArguments: true,  hasNonAtomArguments: false, minArguments: 1, maxArguments: 1,         allowedInSet: false, isCollection: false, description: 'The arithmetic mean of all number-type elements'},
    'median':           {isComputed: true,  hasAtomArguments: true,  hasNonAtomArguments: false, minArguments: 1, maxArguments: 1,         allowedInSet: false, isCollection: false, description: 'The median of all number-type elements'},
    'sum':              {isComputed: true,  hasAtomArguments: true,  hasNonAtomArguments: false, minArguments: 1, maxArguments: 2,         allowedInSet: false, isCollection: false, description: 'The sum of all number-type elements; or a number added to each number-type element in a collection; or the sum of adjacent values from two collections'},
    'product':          {isComputed: true,  hasAtomArguments: true,  hasNonAtomArguments: false, minArguments: 1, maxArguments: 2,         allowedInSet: false, isCollection: false, description: 'The product of all number-type elements; or a number multiplied by each number-type element in a collection; or the product of adjacent values from two collections'},
    'parseNumber':      {isComputed: true,  hasAtomArguments: true,  hasNonAtomArguments: false, minArguments: 1, maxArguments: 1,         allowedInSet: false, isCollection: false, description: 'A string converted to a number type'},
    'length':           {isComputed: true,  hasAtomArguments: true,  hasNonAtomArguments: false, minArguments: 1, maxArguments: 1,         allowedInSet: false, isCollection: false, description: 'The combined length of all string-type elements'},
    'concatenate':      {isComputed: true,  hasAtomArguments: true,  hasNonAtomArguments: false, minArguments: 1, maxArguments: 1,         allowedInSet: false, isCollection: false, description: 'All string-type elements concatenated to a single string'},
    'lowercase':        {isComputed: true,  hasAtomArguments: true,  hasNonAtomArguments: false, minArguments: 1, maxArguments: 1,         allowedInSet: false, isCollection: false, description: 'All string-type elements converted to lowercase'},
    'uppercase':        {isComputed: true,  hasAtomArguments: true,  hasNonAtomArguments: false, minArguments: 1, maxArguments: 1,         allowedInSet: false, isCollection: false, description: 'All string-type elements converted to uppercase'},
    'trim':             {isComputed: true,  hasAtomArguments: true,  hasNonAtomArguments: false, minArguments: 1, maxArguments: 1,         allowedInSet: false, isCollection: false, description: 'All string-type elements with starting and ending whitespace trimmed'},
    'reverseStrings':   {isComputed: true,  hasAtomArguments: true,  hasNonAtomArguments: false, minArguments: 1, maxArguments: 1,         allowedInSet: false, isCollection: false, description: 'All string-type elements with their characters in reverse order'},
    'replace':          {isComputed: true,  hasAtomArguments: true,  hasNonAtomArguments: true,  minArguments: 3, maxArguments: 3,         allowedInSet: false, isCollection: false, promptArguments: ['', 'Find:', 'Replace:'], atomArguments: [0], description: 'All string-type elements with a particular substring replaced'},
    'regex':            {isComputed: true,  hasAtomArguments: true,  hasNonAtomArguments: true,  minArguments: 4, maxArguments: 4,         allowedInSet: false, isCollection: false, promptArguments: ['', 'Find regular expression:', 'Regular expression flags:', 'Replace:'], atomArguments: [0], description: 'All string-type elements with a particular substring replaced using a regular expression', promptDescription: '<a href="https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions" target="_blank">Regular expression reference</a>'},
    'join':             {isComputed: true,  hasAtomArguments: true,  hasNonAtomArguments: true,  minArguments: 2, maxArguments: 2,         allowedInSet: false, isCollection: false, promptArguments: ['', 'Delimiter:'], atomArguments: [0], description: 'All string-type elements from a collection (non-recursive) combined to a single string with a delimiter'},
    'split':            {isComputed: true,  hasAtomArguments: true,  hasNonAtomArguments: true,  minArguments: 2, maxArguments: 2,         allowedInSet: false, isCollection: false, promptArguments: ['', 'Delimiter:'], atomArguments: [0], description: 'A string-type element converted to an array based on a provided delimiter'},
    'union':            {isComputed: true,  hasAtomArguments: true,  hasNonAtomArguments: false, minArguments: 2, maxArguments: 2,         allowedInSet: false, isCollection: false, description: 'Set with combined members of both collection arguments'},
    'intersection':     {isComputed: true,  hasAtomArguments: true,  hasNonAtomArguments: false, minArguments: 2, maxArguments: 2,         allowedInSet: false, isCollection: false, description: 'Set with members that are in both collection arguments'},
    'unique':           {isComputed: true,  hasAtomArguments: true,  hasNonAtomArguments: false, minArguments: 1, maxArguments: 2,         allowedInSet: false, isCollection: false, description: 'Set with members that each occur only in one or the other collection argument, but not both. Also known as "symmetric difference".'},
    'uniqueLeft':       {isComputed: true,  hasAtomArguments: true,  hasNonAtomArguments: false, minArguments: 2, maxArguments: 2,         allowedInSet: false, isCollection: false, description: 'Set with members that are in the first argument but not the second. In set theory, the "difference" operation.'},
    'uniqueRight':      {isComputed: true,  hasAtomArguments: true,  hasNonAtomArguments: false, minArguments: 2, maxArguments: 2,         allowedInSet: false, isCollection: false, description: 'Set with members that are in the second argument but not the first. In set theory, the "difference" operation.'},
    'sort':             {isComputed: true,  hasAtomArguments: true,  hasNonAtomArguments: false, minArguments: 1, maxArguments: 1,         allowedInSet: false, isCollection: false, description: 'A mirror of an array, sorted'},
    'reverse':          {isComputed: true,  hasAtomArguments: true,  hasNonAtomArguments: false, minArguments: 1, maxArguments: 1,         allowedInSet: false, isCollection: false, description: 'A mirror of an array, in reverse order'},
    'keys':             {isComputed: true,  hasAtomArguments: true,  hasNonAtomArguments: false, minArguments: 1, maxArguments: 1,         allowedInSet: false, isCollection: false, description: 'A set with the keys of an array or dictionary as its members'},
    'values':           {isComputed: true,  hasAtomArguments: true,  hasNonAtomArguments: false, minArguments: 1, maxArguments: 1,         allowedInSet: false, isCollection: false, description: 'An array with the values of a collection as its members'}
};

var isJson = function(str) {
    try {
        JSON.parse(str);
    } catch (e) {
        return false;
    }
    return true;
};

// This is a helper function to work around the limitation in $.extend that skips over "undefined" values.
// It was needed in an older version of the data model that used "undefined" literals. It turns out,
// we no longer need that workaround. However, just keeping this function in the code to avoid transplanting it.
var cloneArrayWithoutExcludingUndefined = function(array) {
    var newArray = [];
    for (var i = 0; i < array.length; i++) {
        newArray.push(array[i]);
    }
    return newArray;
};

var refresh = function() {
    recalculate();
    render();
    
    $.each(actionsHistory, function(i, action) {
        action.traversedYet = false;
    });
};

var advanceToRevision = function(n) {
    $.each(actionsHistory, function(i, action) {
        action.traversedYet = false;
    });
    return advanceToRevisionIterate(n);
}

var advanceToRevisionIterate = function(n) {
    if (actionsHistory[n].traversedYet == false) {
        actionsHistory[n].traversedYet = true;
    } else {
    }
    if (actionsHistory[n].fullStateAtoms !== null) {
        atoms = $.extend(true, {}, actionsHistory[n].fullStateAtoms);
        $.each(atoms, function(i, atom) {
            // Commented as some of the cookbook recipes intentionally have some of the collections collapsed at the start, for neatness.
            // atom.isExpanded = true;
        });
        updateHistoryStatus(n);
        recalculate();
    } else {
        advanceToRevisionIterate(actionsHistory[n].basedOn);
        processAction(actionsHistory[n]);
    }
};

var updateHistoryStatus = function(n) {
    actionsHistoryPointer = n;
    if (actionsHistoryPointer == maximumActionsHistoryId) {
        $('.revision-current').html('Viewing latest revision');
    } else {
        $('.revision-current').html('Older revision &ndash; ' + $('<div>').text(actionsHistory[n].description).html());
    }
};

var revisionDescription = function(n) {
    var action = actionsHistory[n];
    
    var html = '';
    if (action.who) {
        html += $('<div>').text(action.who.substr(0, 15)).html() + ' &ndash; ';
    }
    html += $('<div>').text(action.description).html() + '<br/><span style="font-size: smaller;"><em>';
    var age = new Date().getTime() - action.when;
    if (age < 8000) {
        html += 'Just now'
    }
    if (age >= 8000 && age < 20000) {
        html += 'A few seconds ago';
    }
    if (age >= 20000 && age < 60000) {
        html += 'Less than 1 minute ago';
    }
    if (age >= 60000 && age < 120000) {
        html += '1 minute ago';
    }
    if (age >= 120000 && age < 3600000) {
        html += Math.floor(age / 60000) + ' minutes ago';
    }
    if (age >= 3600000 && age < 7200000) {
        html += '1 hour ago';
    }
    if (age >= 7200000 && age < 86400000) {
        html += Math.floor(age / 3600000) + ' hours ago';
    }
    if (age >= 86400000 && age < 172800000) {
        html += '1 day ago';
    }
    if (age >= 172800000) {
        html += Math.floor(age / 86400000) + ' days ago';
    }
    html += '</em></span>';
    
    return html;
};

var actionTemplate = {
    id: 0,
    basedOn: -1,
    fullStateAtoms: null,
    who: '',
    when: new Date().getTime(),
    steps: [],
    jumpTo: null,
    jumpType: 'normal', // or 'undo' or 'redo'
    description: '',
    isSaved: false,
    isRejected: false,
    traversedYet: false
};

var stepTemplate = {
    predicate: '',
    atomId: '', // all predicates except 'import'
    childOf: '', // 'create' and 'move'
    position: '', // 'create' and 'move' (ordinal or key)
    formula: '', // 'create' and 'change'
    args: [], // 'create' and 'change'
    atoms: [], // 'import'
    columnAtoms: [] // 'import'
};

var predicateList = [
    'import',
    'create',
    'delete',
    'change',
    'move',
    'noop'
];

var processAction = function(action) {
    var atom;
    if (action.jumpTo !== null) {
        advanceToRevisionIterate(action.jumpTo);
    } else {
        $.each(action.steps, function(stepNum, step) {
            switch (step.predicate) {
                case 'import':
                    $.each(step.atoms, function(i, importAtom) {
                        var newAtom = $.extend(true, {}, importAtom);
                        newAtom.type = '';
                        newAtom.data = 0;
                        newAtom.isDirty = false;
                        // newAtom.isChanged = false;
                        newAtom.traversedYet = false;
                        atoms[importAtom.id] = newAtom;
                    });
                    $.each(step.columnAtoms, function(i, columnAtomId) {
                        atoms['0'].args.push(columnAtomId);
                    });
                    break;
                case 'create':
                    atom = $.extend(true, {}, atomTemplate);
                    atom.id = step.atomId;
                    atom.formula = step.formula;
                    atom.args = cloneArrayWithoutExcludingUndefined(step.args);
                    if (atoms[step.childOf].formula == 'list') {
                        atoms[step.childOf].args.splice(step.position, 0, step.atomId);
                    } else { // dictionary
                        atoms[step.childOf].args.push({
                            key: step.position,
                            value: step.atomId
                        });
                        atoms[step.childOf].args.sort(dictionaryCompare);
                    }
                    atoms[atom.id] = atom;
                    break;
                case 'delete':
                    deleteAtom(step.atomId, true);
                    break;
                case 'change':
                    atom = atoms[step.atomId];
                    // Changing the formula always deletes children of a list or dictionary.
                    // (These are the only two formula types that can have child atoms.)
                    if (atom.formula == 'list') {
                        $.each(atom.args, function(i, child) {
                            deleteAtom(child, false);
                        });
                    }
                    if (atom.formula == 'dictionary') {
                        $.each(atom.args, function(i, child) {
                            deleteAtom(child.value, false);
                        });
                    }
                    // Update the target atom.
                    atom.formula = step.formula;
                    atom.args = cloneArrayWithoutExcludingUndefined(step.args);
                    break;
                case 'move':
                    // Find the container atom and remove the target atom.
                    $.each(atoms, function(i, atom) {
                        var found = -1;
                        if (atom.formula == 'list') {
                            $.each(atom.args, function(j, subAtom) {
                                if (subAtom == step.atomId) {
                                    found = j;
                                }
                            });
                            if (found != -1) {
                                atom.args.splice(found, 1);
                            }
                        }
                        if (atom.formula == 'dictionary') {
                            $.each(atom.args, function(j, subAtom) {
                                if (subAtom.value == step.atomId) {
                                    found = j;
                                }
                            });
                            if (found != -1) {
                                atom.args.splice(found, 1);
                            }
                        }
                    });
                    // Insert the target atom in the new container.
                    if (atoms[step.childOf].formula == 'list') {
                        atoms[step.childOf].args.splice(step.position, 0, step.atomId);
                    } else { // dictionary
                        atoms[step.childOf].args.push({
                            key: step.position,
                            value: step.atomId
                        });
                        atoms[step.childOf].args.sort(dictionaryCompare);
                    }
                    break;
            }
            
            assertNoAtomLoops();
        });
        
        // If uncommented, this would make every action store the entire state and basically moot the notion of incremental action steps. Simpler, but hugely memory and bandwidth inefficient.
        // action.fullStateAtoms = $.extend(true, {}, atoms);
    }
    updateHistoryStatus(action.id);
    
    lastTimeResetUpdateInterval = new Date().getTime();
};

var deleteAtom = function(atom, deleteFromParent) {
    // Delete children.
    if (atoms[atom].formula == 'list') {
        $.each(atoms[atom].args, function(i, child) {
            deleteAtom(child, false);
        });
    }
    if (atoms[atom].formula == 'dictionary') {
        $.each(atoms[atom].args, function(i, child) {
            deleteAtom(child.value, false);
        });
    }
    // Delete from parent.
    if (deleteFromParent) {
        $.each(atoms, function(i, container) {
            var found = -1;
            if (container.formula == 'list') {
                $.each(container.args, function(j, subAtom) {
                    if (subAtom == atom) {
                        found = j;
                    }
                });
                if (found != -1) {
                    container.args.splice(found, 1);
                }
            }
            if (container.formula == 'dictionary') {
                $.each(container.args, function(j, subAtom) {
                    if (subAtom.value == atom) {
                        found = j;
                    }
                });
                if (found != -1) {
                    container.args.splice(found, 1);
                }
            }
        });
    }
    // Change formulas with this atom as an argument to literalUndefined
    $.each(atoms, function(id, referee) {
        var refersTo = false;
        if (formulas[referee.formula].hasAtomArguments && !formulas[referee.formula].hasNonAtomArguments) {
            $.each(referee.args, function(i, arg) {
                if (arg == atom) {
                    refersTo = true;
                }
            });
        }
        if (formulas[referee.formula].hasAtomArguments && formulas[referee.formula].hasNonAtomArguments && formulas[referee.formula].hasOwnProperty('atomArguments')) {
            $.each(formulas[referee.formula].atomArguments, function(i, argNum) {
                var arg = referee.args[argNum];
                if (arg == atom) {
                    refersTo = true;
                }
            });
        }
        if (refersTo) {
            referee.formula = 'literalUndefined';
            referee.args = [];
        }
    });
    // Delete target atom.
    delete atoms[atom];
};

// Loops in atom references can only happen as a result of data conflicts--never any solely single-user actions taken through the UI.
// This function is used (within a try/catch block) when determining whether data sync conflicts can be cleanly resolved.
// It throws an exception if a loop is found.
var assertNoAtomLoops = function() {
    $.each(atoms, function(i, atom) {
        atom.traversedYet = false;
    });
    assertNoAtomLoopsIterate('0');
};

var assertNoAtomLoopsIterate = function(atomId) {
    var atom = atoms[atomId];
    if (atom.traversedYet) {
        throw "loop";
    }
    atom.traversedYet = true;
    if (atom.formula == 'list') {
        $.each(atom.args, function(i, arg) {
            assertNoAtomLoopsIterate(arg);
        });
    }
    if (atom.formula == 'dictionary') {
        $.each(atom.args, function(i, arg) {
            assertNoAtomLoopsIterate(arg.value);
        });
    }
};

var dictionaryCompare = function(a, b) {
    // sort strings numerically
    if (!isNaN(a.key) && !isNaN(b.key) && a.key.search(/ /) == -1 && b.key.search(/ /) == -1) {
        return (+a.key) - (+b.key);
    }
    // sort numeric strings before non-numeric strings
    if (!isNaN(a.key) && a.key.search(/ /) == -1) {
        return -1;
    }
    if (!isNaN(b.key) && b.key.search(/ /) == -1) {
        return 1;
    }
    
    return a.key.localeCompare(b.key);
};

// When set elements are different types, sort in this order
var typeSort = {
    'number': 1,
    'string': 2,
    'boolean': 3,
    'null': 4,
    'undefined': 5,
    'circularReference': 6
};

var dataCompare = function(a, b) {
    // sort strings numerically
    if (typeof a == 'string' && typeof b == 'string' && !isNaN(a) && !isNaN(b) && a.search(/ /) == -1 && b.search(/ /) == -1) {
        a = +a;
        b = +b;
    }
    
    var aType = typeSort[getType(a)];
    var bType = typeSort[getType(b)];
    
    if (aType < bType) {
        return -1;
    }
    if (bType < aType) {
        return 1;
    }
    
    if (aType == 1 || aType == 3) {
        return a - b;
    }
    if (aType == 2) {
        return a.localeCompare(b);
    }
    
    return 0;
};

var recalculate = function() {
    $.each(atoms, function(i, atom) {
        atom.isDirty = true;
    });
    
    var anyDirty = true;
    var madeProgress = false;
    while (anyDirty) {
        anyDirty = false;
        madeProgress = false;
        $.each(atoms, function(i, atom) {
            if (atom.isDirty) {
                recalculateAtom(atom);
                if (atom.isDirty) {
                    anyDirty = true;
                } else {
                    madeProgress = true;
                }
            }
        });
        if (!madeProgress) {
            $.each(atoms, function(i, atom) {
                if (atom.isDirty && !formulas[atom.formula].isCollection) {
                    atom.isDirty = false;
                    atom.type = 'circularReference';
                    atom.data = {specialType: 'circularReference'};
                }
            });
        }
    }
};

var recalculateAtom = function(atom) {
    var previousType = atom.type;
    var previousData = atom.data;
    
    var args = atom.args;
    var type;
    var data;
    
    var argIsDirty = false;
    var argDoesntExist = false; // not checked currently, probably not necessary
    if (formulas[atom.formula].hasAtomArguments && !formulas[atom.formula].hasNonAtomArguments) {
        $.each(atom.args, function(i, arg) {
            if (atoms.hasOwnProperty(arg)) {
                if (atoms[arg].isDirty) {
                    argIsDirty = true;
                }
            } else {
                argDoesntExist = true;
            }
        });
    }
    if (formulas[atom.formula].hasAtomArguments && formulas[atom.formula].hasNonAtomArguments && formulas[atom.formula].hasOwnProperty('atomArguments')) {
        $.each(formulas[atom.formula].atomArguments, function(i, argNum) {
            var arg = atom.args[argNum];
            if (atoms.hasOwnProperty(arg)) {
                if (atoms[arg].isDirty) {
                    argIsDirty = true;
                }
            } else {
                argDoesntExist = true;
            }
        });
    }
    if (atom.formula == 'dictionary') {
        $.each(atom.args, function(i, item) {
            if (atoms[item.value].isDirty) {
                argIsDirty = true;
            }
        });
    }
    
    if (!argIsDirty) {
        var box = [undefined]; // used to pass a reference to a function generator that we can read out of later
        switch (atom.formula) {
            case 'literalString':
                // type = 'string';
                data = args[0];
                break;
            case 'literalNumber':
                // type = 'number';
                data = args[0];
                break;
            case 'literalBoolean':
                // type = 'boolean';
                data = args[0];
                break;
            case 'literalNull':
                // type = 'null';
                data = null;
                break;
            case 'literalUndefined':
                // type = 'undefined';
                data = {specialType: 'undefined'};
                break;
            case 'list':
                // type = 'list';
                data = [];
                data.collectionType = 'list';
                data.isExpanded = atom.isExpanded;
                $.each(args, function(i, arg) {
                    data.push(atoms[arg].data);
                });
                break;
            case 'set':
                // type = 'set';
                data = cloneArrayWithoutExcludingUndefined(args);
                data.collectionType = 'set';
                data.isExpanded = atom.isExpanded;
                break;
            case 'dictionary':
                // type = 'dictionary';
                data = [];
                data.collectionType = 'dictionary';
                data.isExpanded = atom.isExpanded;
                for (var i = 0; i < args.length; i++) {
                    data.push({
                        key: args[i].key,
                        value: atoms[args[i].value].data
                    });
                }
                break;
            case 'jsonPath':
                try {
                    var result = JSONPath({json: exportJson(atoms[args[0]].data).json, path: args[1]});
                    if (result === false) {
                        data = [];
                        data.collectionType = 'list';
                    } else {
                        data = importFromJson(result);
                    }
                } catch (e) {
                    if (e.message.indexOf('query not executed because filter contains possibly unsafe code') != -1) {
                        data = e.message.replace(/jsonPath: /, '');
                    } else {
                        data = {specialType: 'undefined'};
                    }
                }
                // type = getType(data);
                break;
            case 'generate':
                var argStart = atoms[args[0]].data;
                var argEnd = atoms[args[1]].data;
                var code = args[2];
                if (typeof argStart == 'number' && typeof argEnd == 'number') {
                    if (argEnd - argStart <= 10000) {
                        // this is playing with fire
                        if ((' ' + code).match(/[^.\'\"a-zA-Z0-9_$][a-zA-Z_$][a-zA-Z0-9]*/g) || code.match(/\.prototype/gi)) {
                            data = 'error: not executed because formula contains possibly unsafe code';
                        } else {
                            code = code.replace(/@/g, 'j');
                            var results = [];
                            var result;
                            for (var i = Math.ceil(argStart); i < argEnd; i++) {
                                result = undefined;
                                var j = i; // "security" to prevent formula from changing i
                                try {
                                    result = eval('(' + code + ')');
                                } catch(e) {
                                }
                                results.push(result);
                            }
                            data = importFromJson(results);
                        }
                    } else {
                        data = 'error: number of iterations limited to 10000';
                    }
                } else {
                    data = 'error: arguments are not numbers';
                }
                // type = getType(data);
                break;
            case 'expression':
                data = operationExpression(args[0], undefined, args[1]);
                // type = getType(data);
                break;
            case 'expressionDual':
                data = operationExpression(args[0], args[1], args[2]);
                // type = getType(data);
                break;
            case 'clone':
                data = recalculateTraverse(atoms[args[0]].data, operationClone);
                // type = getType(data);
                break;
            case 'cloneShallow':
                data = recalculateTraverse(atoms[args[0]].data, operationClone, true);
                // type = getType(data);
                break;
            case 'flatten':
                recalculateTraverse(atoms[args[0]].data, operationFlatten(box));
                data = box[0];
                data.collectionType = 'list';
                // type = getType(data);
                break;
            case 'count':
                if ($.inArray(atoms[args[0]].type, ['set', 'list', 'dictionary']) != -1) {
                    data = atoms[args[0]].data.length;
                } else {
                    data = 1;
                }
                // type = 'number';
                break;
            case 'smallest':
                recalculateTraverse(atoms[args[0]].data, operationSmallest(box));
                data = box[0];
                // type = getType(data);
                break;
            case 'largest':
                recalculateTraverse(atoms[args[0]].data, operationLargest(box));
                data = box[0];
                // type = getType(data);
                break;
            case 'mean':
                recalculateTraverse(atoms[args[0]].data, operationNumbers(box));
                if (box[0].length == 0) {
                    data = undefined;
                } else {
                    data = 0;
                    $.each(box[0], function(i, v) {
                        data += v;
                    });
                    data /= box[0].length;
                }
                // type = getType(data);
                break;
            case 'median':
                recalculateTraverse(atoms[args[0]].data, operationNumbers(box));
                if (box[0].length == 0) {
                    data = undefined;
                } else {
                    box[0].sort(function(a, b) { return a - b; });
                    if (box[0].length % 2 == 0) {
                        data = (box[0][box[0].length / 2 - 1] + box[0][box[0].length / 2]) / 2;
                    } else {
                        data = box[0][(box[0].length - 1) / 2];
                    }
                }
                // type = getType(data);
                break;
            case 'sum':
                if (args.length == 1) {
                    recalculateTraverse(atoms[args[0]].data, operationSumAccum(box));
                    data = box[0];
                }
                if (args.length == 2) {
                    if ($.inArray(atoms[args[0]].type, ['list', 'dictionary', 'set']) != -1) {
                        if ($.inArray(atoms[args[1]].type, ['list', 'dictionary', 'set']) != -1) {
                            data = recalculateTraversePaired(atoms[args[0]].data, atoms[args[1]].data, operationSumPair, operationSum);
                        } else {
                            data = recalculateTraverse(atoms[args[0]].data, operationSum(atoms[args[1]].data));
                        }
                    } else {
                        if ($.inArray(atoms[args[1]].type, ['list', 'dictionary', 'set']) != -1) {
                            data = recalculateTraverse(atoms[args[1]].data, operationSum(atoms[args[0]].data));
                        }
                    }
                    if (atoms[args[0]].type == 'number' && atoms[args[1]].type == 'number') {
                        data = atoms[args[0]].data + atoms[args[1]].data;
                    }
                    if (atoms[args[0]].type == 'number' && data === undefined) {
                        data = atoms[args[0]].data;
                    }
                    if (atoms[args[1]].type == 'number' && data === undefined) {
                        data = atoms[args[1]].data;
                    }
                }
                // type = getType(data);
                break;
            case 'product':
                if (args.length == 1) {
                    recalculateTraverse(atoms[args[0]].data, operationProductAccum(box));
                    data = box[0];
                }
                if (args.length == 2) {
                    if ($.inArray(atoms[args[0]].type, ['list', 'dictionary', 'set']) != -1) {
                        if ($.inArray(atoms[args[1]].type, ['list', 'dictionary', 'set']) != -1) {
                            data = recalculateTraversePaired(atoms[args[0]].data, atoms[args[1]].data, operationProductPair, operationProduct);
                        } else {
                            data = recalculateTraverse(atoms[args[0]].data, operationProduct(atoms[args[1]].data));
                        }
                    } else {
                        if ($.inArray(atoms[args[1]].type, ['list', 'dictionary', 'set']) != -1) {
                            data = recalculateTraverse(atoms[args[1]].data, operationProduct(atoms[args[0]].data));
                        }
                    }
                    if (atoms[args[0]].type == 'number' && atoms[args[1]].type == 'number') {
                        data = atoms[args[0]].data + atoms[args[1]].data;
                    }
                    if (atoms[args[0]].type == 'number' && data === undefined) {
                        data = atoms[args[0]].data;
                    }
                    if (atoms[args[1]].type == 'number' && data === undefined) {
                        data = atoms[args[1]].data;
                    }
                }
                // type = getType(data);
                break;
            case 'parseNumber':
                data = recalculateTraverse(atoms[args[0]].data, operationParseNumber);
                // type = getType(data);
                break;
            case 'length':
                recalculateTraverse(atoms[args[0]].data, operationLength(box));
                data = box[0];
                // type = getType(data);
                break;
            case 'concatenate':
                recalculateTraverse(atoms[args[0]].data, operationStrings(box));
                data = box[0].join('');
                // type = 'string';
                break;
            case 'lowercase':
                data = recalculateTraverse(atoms[args[0]].data, operationLowercase);
                // type = getType(data);
                break;
            case 'uppercase':
                data = recalculateTraverse(atoms[args[0]].data, operationUppercase);
                // type = getType(data);
                break;
            case 'trim':
                data = recalculateTraverse(atoms[args[0]].data, operationTrim);
                // type = getType(data);
                break;
            case 'reverseStrings':
                data = recalculateTraverse(atoms[args[0]].data, operationReverseStrings);
                // type = getType(data);
                break;
            case 'replace':
                data = recalculateTraverse(atoms[args[0]].data, operationReplace(args[1], args[2]));
                // type = getType(data);
                break;
            case 'regex':
                data = recalculateTraverse(atoms[args[0]].data, operationRegex(args[1], args[2], args[3]));
                // type = getType(data);
                break;
            case 'join':
                recalculateTraverse(atoms[args[0]].data, operationStrings(box), true);
                data = box[0].join(args[1]);
                // type = 'string';
                break;
            case 'split':
                if (typeof atoms[args[0]].data == 'string') {
                    data = atoms[args[0]].data.split(args[1]);
                    data.collectionType = 'list';
                } else {
                    data = undefined;
                }
                // type = getType(data);
                break;
            case 'union':
                data = calculateSetLogic(atoms[args[0]].data, atoms[args[1]].data, 2, operationUnion);
                // type = getType(data);
                break;
            case 'intersection':
                data = calculateSetLogic(atoms[args[0]].data, atoms[args[1]].data, 2, operationIntersection);
                // type = getType(data);
                break;
            case 'unique':
                if (args.length == 2) {
                    data = calculateSetLogic(atoms[args[0]].data, atoms[args[1]].data, 2, operationUnique);
                } else {
                    data = calculateSetLogic(atoms[args[0]].data, undefined, 1, operationUnique);
                }
                // type = getType(data);
                break;
            case 'uniqueLeft':
                data = calculateSetLogic(atoms[args[0]].data, atoms[args[1]].data, 2, operationUniqueLeft);
                // type = getType(data);
                break;
            case 'uniqueRight':
                data = calculateSetLogic(atoms[args[0]].data, atoms[args[1]].data, 2, operationUniqueRight);
                // type = getType(data);
                break;
            case 'sort':
                data = recalculateTraverse(atoms[args[0]].data, operationClone);
                if (getType(data) == 'list') {
                    data.sort(dataCompare);
                }
                // type = getType(data);
                break;
            case 'reverse':
                data = recalculateTraverse(atoms[args[0]].data, operationClone);
                if (getType(data) == 'list') {
                    data.reverse();
                }
                // type = getType(data);
                break;
            case 'keys':
                data = [];
                data.collectionType = 'set';
                if (atoms[args[0]].type == 'list') {
                    $.each(atoms[args[0]].data, function(i, v) {
                        data.push(i);
                    });
                }
                if (atoms[args[0]].type == 'dictionary') {
                    $.each(atoms[args[0]].data, function(i, v) {
                        data.push(v.key);
                    });
                }
                // type = 'set';
                break;
            case 'values':
                var valuesClone = recalculateTraverse(atoms[args[0]].data, operationClone);
                if (getType(valuesClone) == 'dictionary') {
                    data = [];
                    $.each(valuesClone, function(i, v) {
                        data.push(v.value);
                    });
                }
                if (getType(valuesClone) == 'set' || getType(valuesClone) == 'list') {
                    data = valuesClone;
                }
                if (!$.isArray(valuesClone)) {
                    data = [recalculateTraverse(atoms[args[0]].data, operationClone)];
                }
                data.collectionType = 'list';
                // type = 'list';
                break;
        }
        type = getType(data);
    }
    
    if (!argIsDirty) {
        /*
        if (previousType != type || JSON.stringify(dataSignature(previousData)) != JSON.stringify(dataSignature(data))) {
            atom.type = type;
            atom.data = data;
            atom.isChanged = true;
        }
        */
        atom.type = type;
        atom.data = data;
        atom.isDirty = false;
    }
};

var recalculateTraverse = function(data, operation, dontRecurseNext, dontRecurseThis) {
    if ($.isArray(data)) {
        var newCollection = [];
        newCollection.collectionType = data.collectionType;
        newCollection.isExpanded = data.isExpanded;
        newCollection.dataLink = generateAtomId(); // not an atom, just reusing generator function
        if (!dontRecurseThis) {
            switch (data.collectionType) {
                case 'set':
                    $.each(data, function(i, item) {
                        newCollection.push(recalculateTraverse(item, operation, dontRecurseNext, dontRecurseNext));
                    });
                    sanitizeSetData(data);
                    break;
                case 'list':
                    $.each(data, function(i, item) {
                        newCollection.push(recalculateTraverse(item, operation, dontRecurseNext, dontRecurseNext));
                    });
                    break;
                case 'dictionary':
                    $.each(data, function(i, item) {
                        newCollection.push({key: item.key, value: recalculateTraverse(item.value, operation, dontRecurseNext, dontRecurseNext)});
                    });
                    break;
            }
        }
        return newCollection;
    } else {
        return operation(data);
    }
};

// A monster "dual traversal" function used, right now, only for the sum and product formulas when both arguments are collections.
var recalculateTraversePaired = function(dataA, dataB, operationPair, operationSingular) {
    if ($.isArray(dataA) && $.isArray(dataB)) {
        if (dataA.collectionType == 'dictionary' && dataB.collectionType == 'dictionary') {
            var newCollection = [];
            newCollection.collectionType = 'dictionary';
            newCollection.isExpanded = dataA.isExpanded || dataB.isExpanded;
            newCollection.dataLink = generateAtomId();
            var mergeMap = {};
            var processDictionary = function(dictionary) {
                $.each(dictionary, function(i, v) {
                    if (!mergeMap.hasOwnProperty(v.key)) {
                        mergeMap[v.key] = [];
                    }
                    mergeMap[v.key].push(v.value);
                });
            };
            processDictionary(dataA);
            processDictionary(dataB);
            $.each(mergeMap, function(key, value) {
                if (value.length == 1) {
                    newCollection.push({key: key, value: value[0]});
                }
                if (value.length == 2) {
                    newCollection.push({key: key, value: recalculateTraversePaired(value[0], value[1], operationPair, operationSingular)});
                }
            });
            return newCollection;
        }
        if (dataA.collectionType != 'dictionary' && dataB.collectionType != 'dictionary') {
            newCollection = [];
            if (dataA.collectionType == 'set' && dataB.collectionType == 'set') {
                newCollection.collectionType = 'set';
            } else {
                newCollection.collectionType = 'list';
            }
            newCollection.isExpanded = dataA.isExpanded || dataB.isExpanded;
            newCollection.dataLink = generateAtomId();
            for (var i = 0; i < Math.max(dataA.length, dataB.length); i++) {
                if (i < dataA.length && i < dataB.length) {
                    newCollection.push(recalculateTraversePaired(dataA[i], dataB[i], operationPair, operationSingular));
                }
                if (i < dataA.length && i >= dataB.length) {
                    newCollection.push(dataA[i]);
                }
                if (i >= dataA.length && i < dataB.length) {
                    newCollection.push(dataB[i]);
                }
            }
            if (newCollection.collectionType == 'set') {
                sanitizeSetData(newCollection);
            }
            return newCollection;
        }
        if ((dataA.collectionType == 'dictionary' && dataB.collectionType != 'dictionary') || (dataA.collectionType != 'dictionary' && dataB.collectionType == 'dictionary')) {
            var newUndefined = {};
            newUndefined.specialType = 'undefined';
            return newUndefined;
        }
    }
    if ($.isArray(dataA) && !$.isArray(dataB)) {
        return recalculateTraverse(dataA, operationSingular(dataB));
    }
    if (!$.isArray(dataA) && $.isArray(dataB)) {
        return recalculateTraverse(dataB, operationSingular(dataA));
    }
    if (!$.isArray(dataA) && !$.isArray(dataB)) {
        return operationPair(dataA, dataB);
    }
};

// ensures sets are "sorted" (as they are supposed to be unordered)
// and that there are no duplicates (as they are supposed to contain unique values)
// 
// data argument is assumed to be a set without verification
var sanitizeSetData = function(data) {
    data.sort(dataCompare);
    for (var i = 0; i < data.length - 1; i++) {
        if (data[i] === data[i + 1]) {
            data.splice(i, 1);
            i--;
        } else { // multiple undefineds
            if (typeof data[i] == 'object' && typeof data[i + 1] == 'object' && data[i] !== null && data[i + 1] !== null) {
                data.splice(i, 1);
                i--;
            }
        }
    }
};

var operationExpression = function(arg1, arg2, code) {
    var data;
    // this is playing with fire
    if ((' ' + code).match(/[^.\'\"a-zA-Z0-9_$][a-zA-Z_$][a-zA-Z0-9]*/g) || code.match(/\.prototype/gi)) {
        data = 'error: not executed because formula contains possibly unsafe code';
    } else {
        if (typeof arg2 == 'undefined') {
            code = code.replace(/@/g, 'j');
        } else {
            code = code.replace(/@/g, 'j').replace(/#/g, 'k');
        }
        var results = [];
        var result;
        var maxLength;
        var getMaxLength = function(arg) {
            if ($.isArray(atoms[arg].data)) {
                return atoms[arg].data.length;
            } else {
                return 1;
            }
        };
        if (typeof arg2 == 'undefined') {
            maxLength = getMaxLength(arg1);
        } else {
            maxLength = Math.max(getMaxLength(arg1), getMaxLength(arg2));
        }
        var getItem = function(arg, i) {
            if (atoms[arg].type == 'dictionary') {
                if (i < atoms[arg].data.length) {
                    return exportJson(atoms[arg].data[i].value).json;
                } else {
                    return null;
                }
            } else {
                if (atoms[arg].type == 'list' || atoms[arg].type == 'set') {
                    if (i < atoms[arg].data.length) {
                        return exportJson(atoms[arg].data[i]).json;
                    } else {
                        return null;
                    }
                } else {
                    return exportJson(atoms[arg].data).json;
                }
            }
        };
        for (var i = 0; i < maxLength; i++) {
            result = undefined;
            var j = getItem(arg1, i);
            var k;
            if (typeof arg2 == 'undefined') {
                k = undefined;
            } else {
                k = getItem(arg2, i);
            }
            try {
                result = eval('(' + code + ')');
            } catch(e) {
            }
            results.push(result);
        }
        data = importFromJson(results);
    }
    return data;
};

var operationClone = function(argInner) {
    return argInner;
};

var operationFlatten = function(values) {
    values[0] = [];
    return function(argInner) {
        values[0].push(argInner);
        return argInner;
    };
};

var operationSmallest = function(minimum) {
    return function(argInner) {
        if (typeof argInner == 'number') {
            if (minimum[0] === undefined) {
                minimum[0] = argInner;
            } else {
                minimum[0] = Math.min(minimum[0], argInner);
            }
        }
        return argInner;
    };
};

var operationLargest = function(maximum) {
    return function(argInner) {
        if (typeof argInner == 'number') {
            if (maximum[0] === undefined) {
                maximum[0] = argInner;
            } else {
                maximum[0] = Math.max(maximum[0], argInner);
            }
        }
        return argInner;
    };
};

var operationNumbers = function(numbers) {
    numbers[0] = [];
    return function(argInner) {
        if (typeof argInner == 'number') {
            numbers[0].push(argInner);
        }
        return argInner;
    };
};

var operationSumAccum = function(sum) {
    sum[0] = 0;
    return function(argInner) {
        if (typeof argInner == 'number') {
            sum[0] += argInner;
        }
        return argInner;
    };
};

var operationProductAccum = function(product) {
    product[0] = 1;
    return function(argInner) {
        if (typeof argInner == 'number') {
            product[0] *= argInner;
        }
        return argInner;
    };
};

var operationSumPair = function(argA, argB) {
    if (typeof argA == 'number' && typeof argB == 'number') {
        return argA + argB;
    } else {
        var newUndefined = {};
        newUndefined.specialType = 'undefined';
        return newUndefined;
    }
};

var operationProductPair = function(argA, argB) {
    if (typeof argA == 'number' && typeof argB == 'number') {
        return argA * argB;
    } else {
        var newUndefined = {};
        newUndefined.specialType = 'undefined';
        return newUndefined;
    }
};

var operationSum = function(argOuter) {
    return function(argInner) {
        if (typeof argInner == 'number' && typeof argOuter == 'number') {
            return argInner + argOuter;
        } else {
            return argInner;
        }
    };
};

var operationProduct = function(argOuter) {
    return function(argInner) {
        if (typeof argInner == 'number' && typeof argOuter == 'number') {
            return argInner * argOuter;
        } else {
            return argInner;
        }
    };
};

var operationParseNumber = function(argInner) {
    if (typeof argInner == 'string' && !isNaN(argInner)) {
        return +argInner;
    } else {
        return argInner;
    }
};

var operationLength = function(length) {
    length[0] = 0;
    return function(argInner) {
        if (typeof argInner == 'string') {
            length[0] += argInner.length;
        }
        return argInner;
    };
};

var operationStrings = function(strings) {
    strings[0] = [];
    return function(argInner) {
        if (typeof argInner == 'string') {
            strings[0].push(argInner);
        }
        return argInner;
    };
};

var operationLowercase = function(argInner) {
    if (typeof argInner == 'string') {
        return argInner.toLocaleLowerCase();
    } else {
        return argInner;
    }
};

var operationUppercase = function(argInner) {
    if (typeof argInner == 'string') {
        return argInner.toLocaleUpperCase();
    } else {
        return argInner;
    }
};

var operationTrim = function(argInner) {
    if (typeof argInner == 'string') {
        return $.trim(argInner);
    } else {
        return argInner;
    }
};

var operationReverseStrings = function(argInner) {
    if (typeof argInner == 'string') {
        return argInner.split('').reverse().join(''); // http://stackoverflow.com/a/16776621 (reversal correctness with surrogate pairs) is acknowledged and deemed outside the scope of this project
    } else {
        return argInner;
    }
};

var operationReplace = function(src, dst) {
    var regex = new RegExp(src.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g'); // http://stackoverflow.com/a/3561711
    return function(argInner) {
        if (typeof argInner == 'string') {
            return argInner.replace(regex, dst);
        } else {
            return argInner;
        }
    };
};

var operationRegex = function(src, flags, dst) {
    var regex;
    try {
        regex = new RegExp(src, flags); // http://stackoverflow.com/a/3561711
    } catch (e) {
    }
    return function(argInner) {
        if (typeof argInner == 'string') {
            if (regex) {
                return argInner.replace(regex, dst);
            } else {
                return undefined;
            }
        } else {
            return argInner;
        }
    };
};

var calculateSetLogic = function(dataA, dataB, numArguments, operation) {
    if ($.isArray(dataA) && ($.isArray(dataB) || numArguments == 1)) {
        var mergeMap = {};
        var processCollection = function(collection, side) {
            var processValue = function(value) {
                if (!$.isArray(value)) {
                    var valueCanonical = typeof value + '-' + value;
                    if (!mergeMap.hasOwnProperty(valueCanonical)) {
                        mergeMap[valueCanonical] = {value: value};
                    }
                    mergeMap[valueCanonical][side] = true;
                }
            };
            if (collection.collectionType == 'dictionary') {
                $.each(collection, function(i, v) {
                    processValue(v.value);
                });
            } else {
                $.each(collection, function(i, v) {
                    processValue(v);
                });
            }
        };
        processCollection(dataA, 'left');
        if (numArguments == 2) {
            processCollection(dataB, 'right');
        }
        
        var newCollection = [];
        newCollection.collectionType = 'set';
        newCollection.isExpanded = dataA.isExpanded || dataB.isExpanded;
        newCollection.dataLink = generateAtomId();
        $.each(mergeMap, function(key, bundle) {
            if (operation(bundle.hasOwnProperty('left'), bundle.hasOwnProperty('right'))) {
                newCollection.push(bundle.value);
            }
        });
        sanitizeSetData(newCollection);
        return newCollection;
    } else {
        return undefined;
    }
};

var operationUnion = function(argLeft, argRight) {
    return argLeft || argRight;
};

var operationIntersection = function(argLeft, argRight) {
    return argLeft && argRight;
};

var operationUnique = function(argLeft, argRight) {
    return (argLeft && !argRight) || (!argLeft && argRight);
};

var operationUniqueLeft = function(argLeft, argRight) {
    return argLeft && !argRight;
};

var operationUniqueRight = function(argLeft, argRight) {
    return !argLeft && argRight;
};

var recalculateColumnLayout = function(force) {
    var now = new Date().getTime();
    
    if (force || inScrollAnimation || ((now - timeOfLastColumnRecalculate) > 100 && $('.fancybox-overlay').length == 0)) {
        var minWidth = 224;
        var startWidth = 448;
        var margin = 8;
        
        // Sizing algorithm:
        // 
        // 1. Start with the starting width.
        // 2. Decrease if needed to fit all on screen without scrolling (assume no width for scroll arrows), but not beyond minimum width.
        // 3. If the size we're at doesn't fit a single column on screen, decrease it until it does (now, at this stage, assume scroll arrows), even ignoring minimum width at this stage.
        // 4. Finally, if any screen width is "wasted" (taking into account scroll arrows, column width is not an even fraction of the number displayed), increase it to this amount. But only exceed maximum if we're at one column fitting.
        
        // step 1
        var width = startWidth;
        
        // step 2
        width = Math.min(width, ($(window).width() - margin) / $('.columns .column').length - margin);
        var needScrollArrows = false;
        if (width < minWidth) {
            width = minWidth;
            needScrollArrows = true;
        }
        
        // step 3
        if (needScrollArrows) {
            width = Math.min(width, $(window).width() - margin * 4 - 64);
        } else {
            width = Math.min(width, $(window).width() - margin * 2);
        }
        
        // step 4
        var count;
        if (needScrollArrows) {
            count = ($(window).width() - margin * 3 - 64) / (width + margin);
            count = Math.min(Math.floor(count + 0.005), count);
            width = Math.max(width, ($(window).width() - margin * 3 - 64) / count - margin);
        } else {
            count = ($(window).width() - margin) / (width + margin);
            count = Math.min(Math.floor(count + 0.005), count);
            width = Math.max(width, ($(window).width() - margin) / count - margin);
        }
        
        // process animation offset if in progress
        var animationOffset = 0;
        if (inScrollAnimation) {
            animationOffset = 1 - (now - timeWhenAnimationStarts) / (timeWhenAnimationFinishes - timeWhenAnimationStarts);
            if (animationOffset < 0) {
                animationOffset = 0;
                inScrollAnimation = false;
            }
            if (scrollDirection == 'right') {
                animationOffset *= -1;
            }
        }
        
        // position and configure scroll arrows if needed
        if (needScrollArrows) {
            $('.columns').css('left', 32 + margin);
            $('.columns').width($(window).width() - 64 - margin * 2);
            $('.scroll-left').show();
            $('.scroll-right').show();
            $('.scroll-right').css('left', count * (width + margin) + margin * 2 + 32);
            columnFirst = Math.min(columnFirst, $('.columns .column').length - 1);
            if (columnFirst == 0) {
                scrollLeftAllowed = false;
                $('.scroll-left').removeClass('scroll-left-hover');
                $('.scroll-left').addClass('scroll-left-disabled');
            } else {
                scrollLeftAllowed = true;
                $('.scroll-left').removeClass('scroll-left-disabled');
            }
            if (columnFirst < $('.columns .column').length - count) {
                scrollRightAllowed = true;
                $('.scroll-right').removeClass('scroll-right-disabled');
            } else {
                scrollRightAllowed = false;
                $('.scroll-right').removeClass('scroll-right-hover');
                $('.scroll-right').addClass('scroll-right-disabled');
            }
        } else {
            $('.columns').css('left', 0);
            $('.columns').width($(window).width());
            $('.scroll-left').hide();
            $('.scroll-left').removeClass('scroll-left-hover');
            $('.scroll-right').hide();
            $('.scroll-right').removeClass('scroll-right-hover');
            columnFirst = 0;
        }
        
        // position columns per all of the calculations above
        var maxHeight = 1;
        $('.columns .column').each(function(i, column) {
            $(column).css('left', (i - columnFirst - animationOffset) * (width + margin) + margin - 1);
            $(column).css('width', width);
            
            maxHeight = Math.max(maxHeight, $(column).height());
        });
        $('.button-add-column').css('margin-left', (width - 160) / 2);
        $('.button-add-column').css('margin-right', (width - 160) / 2);
        $('.columns').height(maxHeight + 18);
        
        timeOfLastColumnRecalculate = now;
        
        // scale down indentation smoothly when depth exceeds column width
        if (width != previousWidth) {
            if (indentWidth * highestDepth > width - 121) {
                var adjustedIndentWidth = Math.min(1, ((width - 121) / (indentWidth * highestDepth))) * indentWidth;
                
                $('.element').each(function() {
                    $(this).css('padding-left', $(this).data('depth') * adjustedIndentWidth + 44);
                });
                $('.collection-close').each(function() {
                    $(this).css('padding-left', $(this).data('depth') * adjustedIndentWidth + 44);
                });
                $('.button-toggle').each(function() {
                    $(this).css('left', $(this).data('depth') * adjustedIndentWidth + 24);
                });
                $('.button-add').each(function() {
                    $(this).css('left', $(this).data('depth') * adjustedIndentWidth + 4);
                });
            }
        }
        previousWidth = width;
    }
    
    updatePrompt();
    
    updateStatusCenter();
    
    updateUserNotices();
    
    updateChangeHighlight();
};

var scrollLeft = function() {
    if (scrollLeftAllowed) {
        scrollDirection = 'left';
        inScrollAnimation = true;
        timeWhenAnimationFinishes = new Date().getTime() + 100;
        timeWhenAnimationStarts = new Date().getTime();
        columnFirst--;
    }
};

var scrollRight = function() {
    if (scrollRightAllowed) {
        scrollDirection = 'right';
        inScrollAnimation = true;
        timeWhenAnimationFinishes = new Date().getTime() + 100;
        timeWhenAnimationStarts = new Date().getTime();
        columnFirst++;
    }
};

var scrollLeftIfMoveDragging = function() {
    if (uiState == 'moveDragging' && scrollLeftAllowed && new Date().getTime() - timeLastScrolledDragging > 500) {
        scrollLeft();
        moveDraggingElementOffsetX += previousWidth;
        moveDraggingElementContainerOffsetX += previousWidth;
        timeLastScrolledDragging = new Date().getTime();
    }
};

var scrollRightIfMoveDragging = function() {
    if (uiState == 'moveDragging' && scrollRightAllowed && new Date().getTime() - timeLastScrolledDragging > 500) {
        scrollRight();
        moveDraggingElementOffsetX -= previousWidth;
        moveDraggingElementContainerOffsetX -= previousWidth;
        timeLastScrolledDragging = new Date().getTime();
    }
};

var iosUxHack = function() {
    // I make no apology for browser detection, in this instance.
    //
    // Until we have a "feature flag" for "browser zooms in for no reason on focus, leading to a horrible user experience",
    // or "keyboard slams you in the face due to auto-focus as you explore the app", this is how we deal.
    // 
    // This hack also allows us to not have to disable zoom globally (which is bad for accessibility).
    if (bowser.ios) {
        $('input').addClass('ios');
        $('textarea').addClass('ios');
        $('select').addClass('ios');
    }
};

var updatePrompt = function() {
    if ($('.prompt').is(':visible')) {
        $('.prompt').css('width', Math.min(400, $(window).width() - 100));
    }
};

var setStatusCenter = function(token) {
    $('.status-center').show();
    $('.status-center').html($('.status-center-' + token + '-wrapper').html());
    statusCenterDisplay = new Date().getTime();
};

// For "center" notices (usually contextual assistance for particular events)
var updateStatusCenter = function() {
    var now = new Date().getTime();
    if (now - statusCenterDisplay < 3000) {
        if (now - statusCenterDisplay < 2000) {
            $('.status-center').css('opacity', 1.0);
        } else {
            $('.status-center').css('opacity', (3000 - (now - statusCenterDisplay)) / 1000);
        }
    } else {
        $('.status-center').hide();
    }
};

// Notices of real-time edits from other users
var updateUserNotices = function() {
    var now = new Date().getTime();
    for (var i = 0; i < userNotices.length; i++) {
        var userNotice = userNotices[i];
        if (now - userNotice.when < 3000) {
            if (now - userNotice.when < 2000) {
                userNotice.element.css('opacity', '1');
            } else {
                userNotice.element.css('opacity', (3000 - (now - userNotice.when)) / 1000);
            }
        } else {
            userNotice.element.remove();
            userNotices.splice(i, 1);
            i--;
        }
    };
};

// Briefly highlight and fade elements that have just been changed by another user,
// or by any users (including yourself) when switching to a different version.
var updateChangeHighlight = function() {
    var now = new Date().getTime();
    
    var toDelete = [];
    $.each(changeHighlight, function(atomId, when) {
        var $element = $('.atom-id-' + atomId);
        if ($element.length > 0) {
            if ($element.hasClass('element-hover') || $element.hasClass('element-hover-unselectable') || $element.hasClass('element-formula-source') || $element.hasClass('element-formula-target-allowed') || $element.hasClass('element-formula-selected') || $element.hasClass('element-hover-formula')) {
                $element.css('border', '');
            } else {
                if (now - when < 3000) {
                    if (now - when < 2000) {
                        $element.css('border', 'solid 1px rgb(128, 0, 128)');
                    } else {
                        $element.css('border', 'solid 1px rgb(' +
                            Math.floor(((now - when - 2000) / 1000) * 112 + 128) + ', ' +
                            Math.floor(((now - when - 2000) / 1000) * 240) + ', ' +
                            Math.floor(((now - when - 2000) / 1000) * 112 + 128) + ')');
                    }
                }
            }
        }
        
        if (now - when >= 3000) {
            toDelete.push(atomId);
        }
    });
    $.each(toDelete, function(i, v) {
        delete changeHighlight[v];
        $('.atom-id-' + v).css('border', '');
    });
};

// http://stackoverflow.com/a/15850380
var recalculateToolbarSticky = function() {
    if ($(window).scrollTop() >= $('.header-name').height()) {
        $('.header-menu').css('position', 'fixed');
        $('.header-notice').css('position', 'fixed');
        $('.header-notice').css('top', $('.header-menu').height() + 6);
        $('.dropdown').css('position', 'fixed');
        $('.columns').css('margin-top', (15 + $('.header-menu').height() + ((isReadOnly || isPrivate) ? $('.header-notice').height() : 0)) + 'px');
        $('.status').removeClass('near-header');
    } else {
        $('.header-menu').css('position', 'relative');
        $('.header-notice').css('position', 'relative');
        $('.header-notice').css('top', '0');
        $('.dropdown').css('position', 'absolute');
        $('.columns').css('margin-top', '');
        $('.status').addClass('near-header');
    }
    $('.dropdown-revision').css('top', $('.menu-revision').offset().top + 29 - $(window).scrollTop());
    $('.dropdown-revision').css('left', $('.menu-revision').offset().left);
    $('.dropdown-share').css('top', $('.menu-share').offset().top + 29 - $(window).scrollTop());
    $('.dropdown-share').css('left', $('.menu-share').offset().left);
    $('.dropdown-cookbook').css('top', $('.menu-cookbook').offset().top + 29 - $(window).scrollTop());
    $('.dropdown-cookbook').css('left', $('.menu-cookbook').offset().left);
};

var render = function() {
    $('.columns').html('');
    highestDepth = 0;
    dataLinkIndex = {};
    $.each(atoms['0'].args, function(position, column) {
        var $column = $('<div class="column"></div>');
        $('.columns').append($column);
        renderData(atoms[column], position, $column, 0, undefined, false);
    });
    var $column = $('<div class="column column-placeholder collection-close" data-atom="0"><div class="button-add-column"></div></div>');
    $('.columns').append($column);
    $column.find('.button-add-column').on('click', function() {
        if (uiState == 'normal') {
            addColumn();
        }
    });
    $column.on('mouseenter', function() {
        if (uiState == 'normal') {
            $(this).addClass('element-hover-unselectable');
        }
        if (uiState == 'moveDragging') {
            $(this).addClass('element-hover');
        }
    });
    $column.on('mouseleave', function() {
        if (uiState == 'normal' || uiState == 'moveDragging') {
            $(this).removeClass('element-hover-unselectable');
        }
        if (uiState == 'moveDragging') {
            $(this).removeClass('element-hover');
        }
    });
    
    previousWidth = 0;
    recalculateColumnLayout(true);
    
    $('.status').hide();
    
    if (undoRedo(false, true)) {
        $('.menu-undo').removeClass('menu-disabled');
    } else {
        $('.menu-undo').addClass('menu-disabled');
        $('.menu-undo').removeClass('menu-hover');
    }
    if (undoRedo(true, true)) {
        $('.menu-redo').removeClass('menu-disabled');
    } else {
        $('.menu-redo').addClass('menu-disabled');
        $('.menu-redo').removeClass('menu-hover');
    }
};

var renderData = function(atom, key, $column, depth, setParent, parentIsLiteralDictionary) {
    highestDepth = Math.max(depth, highestDepth);
    var $element = $('<div class="element"></div>');
    var $elementClose;
    $column.append($element);
    var $container;
    var containerId; 
    if (atom.type == 'list' || atom.type == 'set' || atom.type == 'dictionary') {
        containerId = generateAtomId(); // not an atom, just reusing the ID generator
        $container = $('<div class="element-container element-container-id-' + containerId + '"></div>');
        $column.append($container);
    }
    $element.css('padding-left', depth * indentWidth + 44);
    $element.data('depth', depth);
    var html = '';
    if (typeof key == 'number') {
        html += '<span class="format-key-number">' + key + '</span><span class="format-key-separator"> : </span>';
    }
    if (typeof key == 'string') {
        var keyFormatted;
        if (wrapCollapsed && key.length > 60) {
            keyFormatted = $('<div>').text(key.substr(0, 60)).html().replace(/ /, '&nbsp;') + '<em>[&hellip;]</em>';
        } else {
            keyFormatted = $('<div>').text(key).html().replace(/ /, '&nbsp;');
        }
        html += '<span class="format-key-string">' + keyFormatted + '&nbsp;</span><span class="format-key-separator">: </span>';
    }
    switch (atom.type) {
        case 'string':
            if (wrapCollapsed && atom.data.length > 120) {
                html += $('<div>').text(atom.data.substr(0, 120)).html().replace(/\n/g, '<br/>') + '<em>[&hellip;]</em>';
            } else {
                html += $('<div>').text(atom.data).html().replace(/\n/g, '<br/>');
            }
            $element.addClass('format-string');
            break;
        case 'number':
            html += atom.data;
            $element.addClass('format-number');
            break;
        case 'boolean':
            html += atom.data;
            $element.addClass('format-boolean');
            break;
        case 'null':
            html += 'null';
            $element.addClass('format-null');
            break;
        case 'undefined':
            html += 'undefined';
            $element.addClass('format-undefined');
            break;
        case 'circularReference':
            html += '!circular';
            $element.addClass('format-circular-reference');
            break;
        case 'list':
            html += '[<span class="collapsed" style="display: none;">&hellip;] <em>' + atom.data.length + ' element' + (atom.data.length == 1 ? '' : 's') + '</em></span>';
            $element.addClass('format-list');
            if (atom.formula == 'list') {
                $.each(atom.args, function(position, subAtomId) {
                    renderData(atoms[subAtomId], position, $container, depth + 1, undefined, false);
                });
            } else {
                $.each(atom.data, function(position, value) {
                    renderData(boxAtom(value), position, $container, depth + 1, undefined, false);
                });
            }
            $elementClose = $('<div class="element collection-close format-list"></div>');
            $elementClose.html(']');
            break;
        case 'set':
            html += '(<span class="collapsed" style="display: none;">&hellip;) <em>' + atom.data.length + ' element' + (atom.data.length == 1 ? '' : 's') + '</em></span>';
            $element.addClass('format-set');
            $.each(atom.data, function(i, value) {
                renderData(boxAtom(value), null, $container, depth + 1, (atom.formula == 'set' ? atom.id : undefined), false);
            });
            $elementClose = $('<div class="element collection-close format-set"></div>');
            $elementClose.html(')');
            break;
        case 'dictionary':
            html += '{<span class="collapsed" style="display: none;">&hellip;} <em>' + atom.data.length + ' element' + (atom.data.length == 1 ? '' : 's') + '</em></span>';
            $element.addClass('format-dictionary');
            if (atom.formula == 'dictionary') {
                $.each(atom.args, function(position, item) {
                    renderData(atoms[item.value], item.key, $container, depth + 1, undefined, true);
                });
            } else {
                $.each(atom.data, function(position, item) {
                    renderData(boxAtom(item.value), item.key, $container, depth + 1, undefined, false);
                });
            }
            $elementClose = $('<div class="element collection-close format-dictionary"></div>');
            $elementClose.html('}');
            break;
    }
    $element.html(html);
    if (parentIsLiteralDictionary) {
        $element.find('.format-key-string').addClass('format-key-string-renamable');
        $element.find('.format-key-string-renamable').on('click', function(event) {
            if (uiState == 'normal') {
                renameKey($(this));
                event.stopPropagation();
            }
        });
    }
    
    if (atom.type == 'list' || atom.type == 'set' || atom.type == 'dictionary') {
        $container.append($elementClose);
        $elementClose.css('padding-left', depth * indentWidth + 44);
        $elementClose.data('depth', depth);
        $elementClose.data('atom', atom.id);
        $elementClose.on('mouseenter', function() {
            displayElementStatus($(this));
        });
        $elementClose.on('mouseleave', function() {
            hideElementStatus($(this));
        });
        
        var $toggle = $('<div class="button button-toggle button-toggle-collapse"></div>');
        $element.append($toggle);
        $toggle.css('left', depth * indentWidth + 24);
        $toggle.data('depth', depth);
        $element.data('container', containerId);
        $toggle.data('container', containerId);
        $toggle.on('click', function(event) {
            toggleExpand($(this));
            event.stopPropagation();
        });
        if (!atom.isExpanded) {
            $toggle.trigger('click');
        }
    }
    if (atom.id || setParent) {
        $element.append('<div class="button button-delete" style="display: none;"></div>');
        $element.find('.button-delete').on('click', function(event) {
            deleteElement($element);
            event.stopPropagation();
        });
        
        $element.append('<div class="button button-move" style="display: none;"></div>');
        $element.find('.button-move').on('mousedown touchstart', function(event) {
            event.preventDefault();
            moveMouseDown($(this));
        });
        
        if (depth > 0) {
            $element.append('<div class="button button-add" style="display: none;"></div>');
            $element.find('.button-add').css('left', depth * indentWidth + 4);
            $element.find('.button-add').data('depth', depth);
            $element.find('.button-add').on('click', function(event) {
                add($element);
                event.stopPropagation();
            });
        }
    }
    if (atom.formula == 'list' || atom.formula == 'set' || atom.formula == 'dictionary') {
        $elementClose.append('<div class="button button-add" style="display: none;"></div>');
        $elementClose.find('.button-add').css('left', (depth + 1) * indentWidth + 4);
        $elementClose.find('.button-add').data('depth', depth + 1);
        $elementClose.find('.button-add').on('click', function(event) {
            add($elementClose);
            event.stopPropagation();
        });
    }
    
    $element.data('atom', atom.id);
    $element.data('data', [atom.data]);
    if (typeof atom.data == 'object' && atom.data !== null && atom.data.hasOwnProperty('dataLink')) {
        $element.data('dataLink', atom.data.dataLink); // for tracking expand/collapse (sort of) of generated elements
        dataLinkIndex[atom.data.dataLink] = atom.data;
    }
    $element.data('key', [key]);
    if (setParent) {
        $element.data('set-parent', setParent);
    }
    if (atom.id) {
        $element.addClass('atom-id-' + atom.id);
    }
    
    // When tapping an element that also has a mouse hover event,
    // iOS treats the first touch as a mouse hover only, and only the second as a click.
    // Android treats the first touch as a click. (You can tap and hold to make it a "hover only".)
    // We browser-detect Android to imitate iOS's behavior. This is acknowledged to be not ideal,
    // but is from a history of experience of it being maddening to get touch-based controls working
    // in all browsers and all platforms.
    // 
    // (Further down, we have a hack for iOS to imitate Android's behavior, in another case where it makes more sense.)
    $element.on('click', function() {
        if (uiState == 'normal') {
            if (bowser.android) {
                if ($element.hasClass('element-hover') || $element.hasClass('element-hover-unselectable')) {
                    change($element);
                } else {
                    displayElementStatus($(this));
                }
            } else {
                change($element);
            }
        }
        if (uiState == 'formulaChoosing') {
            pickFormulaElement($element, false);
        }
    });
    
    $element.on('mouseenter', function(event) {
        if (!bowser.android || uiState == 'moveDragging') {
            displayElementStatus($(this));
        }
    });
    $element.on('mouseleave', function() {
        hideElementStatus($(this));
    });
    
    // When choosing a formula with touch, choose on the first tap - avoid the forced double tap caused by absorbing the first and changing it to a faux-mouseenter event.
    // Only treat as a tap if it's within 300ms, to allow for dragging (to scroll).
    $element.on('touchstart', function() {
        if (uiState == 'formulaChoosing') {
            $element.data('touchstart-at', new Date().getTime());
        }
    });
    $element.on('touchend', function(event) {
        if (uiState == 'formulaChoosing') {
            if (new Date().getTime() - $element.data('touchstart-at') < 300) {
                $(this).trigger('click');
                event.preventDefault();
            }
        }
    });
};

// Create a temporary "atom" (with a bogus ID) from a data element.
// Analogous to boxing in Java or C#.
var boxAtom = function(data) {
    var atom = $.extend(true, {}, atomTemplate);
    atom.data = data;
    atom.formula = 'noop';
    if (data === null) {
        atom.type = 'null';
    } else {
        if ($.isArray(data)) {
            atom.type = data.collectionType;
            atom.isExpanded = data.isExpanded;
        } else {
            if (typeof data == 'object') {
                atom.type = data.specialType; // undefined or circular reference
            } else {
                atom.type = typeof data;
            }
        }
    }
    return atom;
};

var getType = function(data) {
    return boxAtom(data).type;
};

// Convert our ad-hoc data format to actual JSON (well, JavaScript object, not a string).
var exportJson = function(data) {
    var encounteredSet = false;
    var encounteredUndefined = false;

    var exportJsonIterate = function(data) {
        if (!$.isArray(data)) {
            if (data === null) {
                return null;
            } else {
                if (typeof data == 'object') {
                    if (data.specialType == 'undefined') {
                        encounteredUndefined = true;
                        return null;
                    }
                    if (data.specialType == 'circularReference') {
                        return null;
                    }
                } else {
                    return data;
                }
            }
        } else {
            var newCollection;
            switch (data.collectionType) {
                case 'set':
                    encounteredSet = true;
                case 'list':
                    newCollection = [];
                    $.each(data, function(i, v) {
                        newCollection.push(exportJsonIterate(v));
                    });
                    return newCollection;
                    break;
                case 'dictionary':
                    newCollection = {};
                    $.each(data, function(i, v) {
                        newCollection[v.key] = exportJsonIterate(v.value);
                    });
                    return newCollection;
                    break;
            }
        }
    };
    
    var result = {json: exportJsonIterate(data)};
    result.encounteredSet = encounteredSet;
    result.encounteredUndefined = encounteredUndefined;
    
    return result;
};

// For version change highlights.
var addChangeHighlight = function(oldVersion, newVersion, append) {
    var now = new Date().getTime();
    
    if (!append) {
        clearChangeHighlight();
    }
    
    var state = saveState();
    
    advanceToRevision(oldVersion);
    var oldAtoms = $.extend(true, {}, atoms);
    advanceToRevision(newVersion);
    var newAtoms = $.extend(true, {}, atoms);
    
    loadState(state);
    
    $.each(newAtoms, function(id, atom) {
        if (oldAtoms.hasOwnProperty(id)) {
            if (oldAtoms[id].formula != atom.formula || JSON.stringify(oldAtoms[id].args) != JSON.stringify(atom.args)) {
                changeHighlight[id] = now;
            }
        } else {
            changeHighlight[id] = now;
        }
    });
    $.each(actionsHistory[newVersion].steps, function(i, step) {
        changeHighlight[step.atomId] = now;
    });
};

var clearChangeHighlight = function() {
    changeHighlight = {};
};

// Serializes the computed data in a manner so that it can be JSON-stringified and compared with another serialized blob to see if it is equivalent.
// The serialized blob is in a strange format (a flattened format) that is not really useful for anything else.
var dataSignature = function(data) {
    var blob = [];
    dataSignatureIterate(data, blob);
    return blob;
};

var dataSignatureIterate = function(data, blob) {
    var type = getType(data);
    blob.push(type);
    if (type == 'string' || type == 'number' || type == 'boolean') {
        blob.push(data);
    }
    if (type == 'set' || type == 'list') {
        $.each(data, function(i, v) {
            dataSignatureIterate(v, blob);
        });
    }
    if (type == 'dictionary') {
        $.each(data, function(i, v) {
            blob.push(v.key);
            dataSignatureIterate(v.value, blob);
        });
    }
};

var displayElementStatus = function($element) {
    var atomId;
    if (uiState == 'normal') {
        
        atomId = $element.data('atom');
        
        if (!$element.hasClass('collection-close')) {
            var stats = $element.data('stats');
            var data = $element.data('data')[0];
            
            if (!stats) {
                stats = {};
                if (typeof data == 'string') {
                    stats = {
                        lengthString: data.length
                    };
                }
                if ($.isArray(data)) {
                    stats = {
                        countString: 0,
                        countNumber: 0,
                        countTrue: 0,
                        countFalse: 0,
                        countNull: 0,
                        countUndefined: 0,
                        countCircularReference: 0,
                        lengthCharacters: 0,
                        sum: 0,
                        numbers: [],
                    };
                    countStatsIterate(stats, data);
                }
                if (stats.countNumber > 0) {
                    stats.numbers.sort(function(a, b) { return a - b; });
                    stats.min = stats.numbers[0];
                    stats.max = stats.numbers.slice(-1)[0];
                    if (stats.numbers.length % 2 == 1) {
                        stats.median = stats.numbers[(stats.numbers.length - 1) / 2];
                    } else {
                        stats.median = (stats.numbers[stats.numbers.length / 2 - 1] + stats.numbers[stats.numbers.length / 2]) / 2;
                    }
                }
                delete stats.numbers;
                $element.data('stats', stats);
            }
            
            var html = '';
            html += renderStatus(atomId, ($element.data('set-parent') ? true : false), data);
            html += '<br/><br/>';
            var numTypes = 0;
            $.map([stats.countString, stats.countNumber, stats.countTrue, stats.countFalse, stats.countNull, stats.countUndefined, stats.countCircularReference], function(v, i) {
                if (v > 0) {
                    numTypes++;
                }
            });
            if (numTypes > 1) {
                html += '<span class="format-label">Leaf node count: </span><span class="format-number">' + (stats.countString + stats.countNumber + stats.countTrue + stats.countFalse + stats.countNull + stats.countUndefined + stats.countCircularReference) + '</span><br/>';
            }
            if (numTypes > 0) {
                if (stats.countString > 0) { html += '<span class="format-label">String count: </span><span class="format-number">' + stats.countString + '</span><br/>'; }
                if (stats.countNumber > 0) { html += '<span class="format-label">Number count: </span><span class="format-number">' + stats.countNumber + '</span><br/>'; }
                if (stats.countTrue + stats.countFalse > 0) {
                    html += '<span class="format-label">Boolean count: </span><span class="format-number">' + (stats.countTrue + stats.countFalse) + '</span><br/>';
                    if (stats.countTrue > 0) { html += '<span class="format-label">True count: </span><span class="format-number">' + stats.countTrue + '</span><br/>'; }
                    if (stats.countFalse > 0) { html += '<span class="format-label">False count: </span><span class="format-number">' + stats.countFalse + '</span><br/>'; }
                }
                if (stats.countNull > 0) { html += '<span class="format-label">Null count: </span><span class="format-number">' + stats.countNull + '</span><br/>'; }
                if (stats.countUndefined > 0) { html += '<span class="format-label">Undefined count: </span><span class="format-number">' + stats.countUndefined + '</span><br/>'; }
                if (stats.countCircularReference > 0) { html += '<span class="format-label">Circular reference count: </span><span class="format-number">' + stats.countCircularReference + '</span><br/>'; }
            }
            if (stats.countString > 0) {
                html += '<span class="format-label">Combined string length: </span><span class="format-number">' + stats.lengthCharacters + '</span><br/>';
            }
            if (stats.countNumber > 0) {
                html += '<span class="format-label">Sum: </span><span class="format-number">' + stats.sum + '</span><br/>';
            }
            if (stats.countNumber > 1) {
                html += '<span class="format-label">Mean: </span><span class="format-number">' + (stats.sum / stats.countNumber) + '</span><br/>';
                html += '<span class="format-label">Median: </span><span class="format-number">' + stats.median + '</span><br/>';
                html += '<span class="format-label">Min: </span><span class="format-number">' + stats.min + '</span><br/>';
                html += '<span class="format-label">Max: </span><span class="format-number">' + stats.max + '</span><br/>';
            }
            if (stats.hasOwnProperty('lengthString')) {
                html += '<span class="format-label">String length: </span><span class="format-number">' + stats.lengthString + '</span><br/>';
            }
            if (html.slice(-10) == '<br/><br/>') {
                html = html.slice(0, -10);
            }
            
            $('.status .status-text').html(html);
            $('.status').show();
            if ($(window).height() - ($('.status').height() + 100) < $element.offset().top - $(window).scrollTop() &&
                $(window).width() - ($('.status').width() + 200) < $element.offset().left - $(window).scrollLeft()) {
                // Show status near top instead of bottom if it will tend to cover the hovered element
                $('.status').addClass('status-top');
            } else {
                $('.status').removeClass('status-top');
            }
        }
        
        if (atomId && !$element.hasClass('collection-close')) {
            $element.addClass('element-hover');
            
            var formula = atoms[atomId].formula;
            var args = atoms[atomId].args;
            
            if (formulas[formula].isComputed && formulas[formula].hasAtomArguments && !formulas[formula].hasNonAtomArguments) {
                $.each(args, function(i, arg) {
                    $('.element.atom-id-' + arg).each(function() {
                        if (!$(this).hasClass('collection-close')) {
                            $(this).addClass('element-hover-formula');
                        }
                    });
                });
            }
            if (formulas[formula].hasAtomArguments && formulas[formula].hasNonAtomArguments && formulas[formula].hasOwnProperty('atomArguments')) {
                $.each(formulas[formula].atomArguments, function(i, argNum) {
                    var arg = args[argNum];
                    $('.element.atom-id-' + arg).each(function() {
                        if (!$(this).hasClass('collection-close')) {
                            $(this).addClass('element-hover-formula');
                        }
                    });
                });
                
            }
        } else {
            $element.addClass('element-hover-unselectable');
        }
        
        $element.find('.button-delete').show();
        $element.find('.button-move').show();
        $element.find('.button-add').show();
    }
    if (uiState == 'moveDragging') {
        // We only allow moving literal, non-collections, non-computed elements into a set. This could be atoms, or other elements already in a set.
        var canHighlightSetMembers = false;
        if ($moveDraggingElement.data('set-parent')) {
            canHighlightSetMembers = true;
        } else {
            if ($moveDraggingElement.data('atom')) {
                if (formulas[atoms[$moveDraggingElement.data('atom')].formula].allowedInSet) {
                    canHighlightSetMembers = true;
                }
            }
        }
        
        // Highlight if:
        // -The destination is a non-computed value, or
        // -The destination is a set AND we determined above that this is something that can be moved into a set;
        // AND we have a check to make sure we're not detecting a hover for the actual element being dragged.
        if (($element.data('atom') || ($element.data('set-parent') && canHighlightSetMembers)) && !$element.hasClass('element-drag')) {
            $element.addClass('element-hover');
            $moveDraggingElement.removeClass('element-drag-nodrop');
        } else {
            $moveDraggingElement.addClass('element-drag-nodrop');
        }
    }
    if (uiState == 'formulaChoosing') {
        // To be allowable, target must:
        // -Be an atom (not generated, not set member); this could include a formula atom (but not its auto-generated children)
        // -Not be the atom being assigned (or its parent, for adding new)
        // -Not already be in the argument list (for now--this is theoretically desirable in certain cases, but we're not allowing it for now)
        // 
        // A formula that references its descendent or ancestor will produce a circular reference error during the calculation stage.
        // However, we don't disallow that here, as it can happen in other ways (such as moving an atom later). So it's allowed, but will just give the error.
        if (!$element.hasClass('collection-close') && $element.data('atom') && $element.data('atom') != formulaChoosingAtomId && $.inArray($element.data('atom'), formulaChoosingAtomArgs) == -1) {
            $element.addClass('element-formula-target-allowed');
        } else {
            $element.addClass('element-formula-target-disallowed');
        }
        
        if (!$element.hasClass('collection-close')) {
            $('.status .status-text').html(renderStatus($element.data('atom'), ($element.data('set-parent') ? true : false), $element.data('data')[0]) + '<br/><br/>');
        }
    }
};

var renderStatus = function(atomId, isSetMember, data) {
    var html = '';
    if (atomId) {
        var atom = atoms[atomId];
        if (formulas[atom.formula].isComputed) {
            html += '<span class="format-label">Formula: </span><span class="format-formula">' + atom.formula + '</span><br/><span class="format-label">Computed data type: </span><span class="format-formula">';
        }
        if (formulas[atom.formula].allowedInSet) {
            html += '<span class="format-label">Explicit value</span><br/><span class="format-label">Data type: </span><span class="format-formula">';
        }
        if (formulas[atom.formula].isCollection) {
            html += '<span class="format-label">Collection</span><br/><span class="format-label">Data type: </span><span class="format-formula">';
        }
    } else {
        if (isSetMember) {
            html += '<span class="format-label">Explicit value</span><br/><span class="format-label">Data type: </span><span class="format-formula">';
        } else {
            html += '<span class="format-label">Generated element</span><br/><span class="format-label">Computed data type: </span><span class="format-formula">';
        }
    }
    if (data === null) {
        html += 'Null';
    } else {
        if ($.isArray(data)) {
            html += data.collectionType.charAt(0).toUpperCase() + data.collectionType.substr(1);
        } else {
            if (typeof data == 'object') {
                if (data.specialType == 'undefined') {
                    html += 'Undefined';
                }
                if (data.specialType == 'circularReference') {
                    html += 'Circular reference';
                }
            } else {
                html += (typeof data).charAt(0).toUpperCase() + (typeof data).substr(1);
            }
        }
    }
    return html;
};

var countStatsIterate = function(runningStats, data) {
    if (data === null) {
        runningStats.countNull++;
    } else {
        if ($.isArray(data)) {
            switch (data.collectionType) {
                case 'list':
                case 'set':
                    $.each(data, function(i, subData) {
                        countStatsIterate(runningStats, subData);
                    });
                    break;
                case 'dictionary':
                    $.each(data, function(i, subData) {
                        countStatsIterate(runningStats, subData.value);
                    });
                    break;
            }
        } else {
            if (typeof data == 'object') {
                switch (data.specialType) {
                    case 'undefined':
                        runningStats.countUndefined++;
                        break;
                    case 'circularReference':
                        runningStats.countCircularReference++;
                        break;
                }
            } else {
                switch (typeof data) {
                    case 'string':
                        runningStats.countString++;
                        runningStats.lengthCharacters += data.length;
                        break;
                    case 'number':
                        runningStats.countNumber++;
                        runningStats.sum += data;
                        runningStats.numbers.push(data);
                        break;
                    case 'boolean':
                        if (data) {
                            runningStats.countTrue++;
                        } else {
                            runningStats.countFalse++;
                        }
                        break;
                }
            }
        }
    }
};

var hideElementStatus = function($element) {
    if (uiState == 'normal') {
        $element.removeClass('element-hover');
        $element.removeClass('element-hover-unselectable');
        $('.element').removeClass('element-hover-formula');
        
        $('.status').hide();
        $element.find('.button-delete').hide();
        $element.find('.button-move').hide();
        $element.find('.button-add').hide();
    }
    if (uiState == 'moveDragging') {
        $element.removeClass('element-hover');
        $moveDraggingElement.removeClass('element-drag-nodrop');
    }
    if (uiState == 'formulaChoosing') {
        $element.removeClass('element-formula-target-allowed');
        $element.removeClass('element-formula-target-disallowed');
        
        $('.status .status-text').html('');
    }
};

var toggleExpand = function($element) {
    if ($element.hasClass('button-toggle-collapse')) {
        $element.removeClass('button-toggle-collapse');
        $element.addClass('button-toggle-expand');
        $('.element-container-id-' + $element.data('container')).hide();
        $element.closest('.element').find('.collapsed').show();
        if ($element.closest('.element').data('atom')) {
            atoms[$element.closest('.element').data('atom')].isExpanded = false;
        }
        if ($element.closest('.element').data('dataLink')) {
            if (dataLinkIndex.hasOwnProperty($element.closest('.element').data('dataLink'))) {
                dataLinkIndex[$element.closest('.element').data('dataLink')].isExpanded = false;
            }
        }
    } else {
        $element.removeClass('button-toggle-expand');
        $element.addClass('button-toggle-collapse');
        $('.element-container-id-' + $element.data('container')).show();
        $element.closest('.element').find('.collapsed').hide();
        if ($element.closest('.element').data('atom')) {
            atoms[$element.closest('.element').data('atom')].isExpanded = true;
        }
        if ($element.closest('.element').data('dataLink')) {
            if (dataLinkIndex.hasOwnProperty($element.closest('.element').data('dataLink'))) {
                dataLinkIndex[$element.closest('.element').data('dataLink')].isExpanded = true;
            }
        }
    }
};

var add = function($element) {
    var childOf;
    var position;
    if ($element.hasClass('button-add-column') > 0) {
        childOf = '0';
        position = atoms['0'].args.length;
    } else {
        if ($element.hasClass('collection-close')) {
            childOf = $element.data('atom');
            if (atoms[childOf].formula == 'list') {
                position = atoms[childOf].args.length;
            }
        } else {
            if ($element.data('set-parent')) {
                childOf = $element.data('set-parent');
            } else {
                var thisAtomId = $element.data('atom');
                $.each(atoms, function(i, checkAtom) {
                    if (checkAtom.formula == 'list') {
                        $.each(checkAtom.args, function(j, item) {
                            if (item == thisAtomId) {
                                childOf = checkAtom.id;
                                position = j;
                            }
                        });
                    }
                    if (checkAtom.formula == 'dictionary') {
                        $.each(checkAtom.args, function(j, item) {
                            if (item.value == thisAtomId) {
                                // childOf = item;
                                childOf = checkAtom.id;
                            }
                        });
                    }
                });
            }
        }
    }
    var atom = atoms[childOf];
    
    $.fancybox($('.prompt-add').prop('outerHTML'), {openEffect: 'none', closeEffect: 'none'});
    if (atom.formula == 'dictionary') {
        $('.fancybox-inner').find('.prompt-add-key').show();
    }
    $('.fancybox-inner').find('.prompt-add-value').show();
    $('.fancybox-inner').find('.prompt-add-type-explanation').show();
    $('.fancybox-inner').find('.prompt-add-type-radio').show();
    $('.fancybox-inner').find('.prompt-add-type-radio-auto').show();
    $('.fancybox-inner').find('.prompt-add-type-radio-string-multi').show();
    $('.fancybox-inner').find('.prompt-add-type-radio-string-single').show();
    $('.fancybox-inner').find('.prompt-add-type-radio-string-single-add').show();
    $('.fancybox-inner').find('.prompt-add-type-radio-auto input').prop('checked', true);
    $('.fancybox-inner').find('.prompt-add-button-use').show();
    $('.fancybox-inner').find('.prompt-add-button-use').val('Add');
    if (atom.formula != 'set') {
        $('.fancybox-inner').find('.prompt-add-button-formula').show();
    }
    if (!bowser.ios && !bowser.android) {
        $('.fancybox-inner').find('textarea[name="value"]').select();
    }
    
    var validateInputAdd = function() {
        var result = validateInput(atom.formula == 'set', (atom.formula == 'dictionary' ? childOf : undefined), false);
        
        if (result) {
            $('.fancybox-inner').find('input[name="use"]').prop('disabled', false);
            $('.fancybox-inner').find('input[name="formula"]').prop('disabled', false);
        } else {
            $('.fancybox-inner').find('input[name="use"]').prop('disabled', true);
            $('.fancybox-inner').find('input[name="formula"]').prop('disabled', true);
        }
    };
    
    $('.fancybox-inner').find('textarea[name="value"]').on('keyup', function(event) {
        if (event.keyCode == 27) {
            $.fancybox.close();
        }
        validateInputAdd();
    });
    $('.fancybox-inner').find('textarea[name="key"]').on('keyup', function(event) {
        if (event.keyCode == 27) {
            $.fancybox.close();
        }
        validateInputAdd();
    });
    $('.fancybox-inner').find('input[name="type"]').on('change', function() {
        validateInputAdd();
    });
    validateInputAdd();
    
    var useButton = function() {
        var action = $.extend(true, {}, actionTemplate);
        action.id = generateActionId();
        action.basedOn = actionsHistoryPointer;
        
        var result = validateInput(atom.formula == 'set', (atom.formula == 'dictionary' ? childOf : undefined), false);
        var type = undefined;
        $.each(result.values, function(i, value) {
            if (type === undefined) {
                type = value.type;
            } else {
                if (type != value.type) {
                    type = 'mixed';
                }
            }
        });
        action.description = 'Add ' + result.values.length + ' ' + {
            'set': 'set',
            'literalBoolean': 'boolean',
            'literalNull': 'null',
            'literalUndefined': 'undefined',
            'literalNumber': 'number',
            'literalStringQuoted': 'string',
            'literalString': 'string',
            'json': 'JSON',
            'mixed': 'mixed type'
        }[type] + ' value' + (result.values.length > 1 ? 's' : '');
        action.descriptionPast = action.description.replace(/Add/, 'added');
        
        if (atom.formula == 'set') {
            var newElements = cloneArrayWithoutExcludingUndefined(atom.args);
            $.each(result.values, function(i, value) {
                newElements.push(value.value);
            });
            
            sanitizeSetData(newElements);
            
            action.steps.push({
                predicate: 'change',
                atomId: childOf,
                formula: 'set',
                args: newElements
            });
        }
        if (atom.formula == 'dictionary' || atom.formula == 'list') {
            $.each(result.values, function(i, value) {
                if ($.inArray(value.type, ['set', 'literalBoolean', 'literalNull', 'literalUndefined', 'literalNumber', 'literalStringQuoted', 'literalString']) != -1) {
                    action.steps.push({
                        predicate: 'create',
                        atomId: generateAtomId(),
                        childOf: childOf,
                        position: (atom.formula == 'dictionary' ? result.keys[i] : position),
                        formula: (value.type == 'literalStringQuoted' ? 'literalString' : value.type),
                        args: {
                            'set': value.value,
                            'literalBoolean': [value.value],
                            'literalNull': [],
                            'literalUndefined': [],
                            'literalNumber': [value.value],
                            'literalStringQuoted': [value.value],
                            'literalString': [value.value]
                        }[value.type]
                    });
                } else {
                    // is 'json'
                    insertDataFromJsonIterate(childOf, (atom.formula == 'dictionary' ? result.keys[i] : position), value.value, action.steps);
                }
                if (atom.formula == 'list') {
                    position++;
                }
            });
        }
        
        actionsHistory[action.id] = action;
        $.fancybox.close();
        processAction(actionsHistory[action.id]);
        refresh();
    };
    
    $('.fancybox-inner').find('input[name="use"]').on('click', function() {
        useButton();
    });
    
    $('.fancybox-inner').find('input[name="formula"]').on('click', function() {
        var result = validateInput(atom.formula == 'set', (atom.formula == 'dictionary' ? childOf : undefined), false);
        
        pickFormula(false, false, undefined, childOf, (atom.formula == 'dictionary' ? result.keys[0] : position));
    });
};

var change = function($element) {
    if (!$element.hasClass('collection-close')) {
        var isSetMember;
        var canEdit;
        var atom;
        var data = $element.data('data')[0];
        var setParent;
        
        if ($element.data('set-parent')) {
            isSetMember = true;
            canEdit = true;
            setParent = atoms[$element.data('set-parent')];
        } else {
            if ($element.data('atom')) {
                atom = atoms[$element.data('atom')];
                canEdit = true;
            } else {
                canEdit = false;
            }
        }
        
        $.fancybox($('.prompt-add').prop('outerHTML'), {openEffect: 'none', closeEffect: 'none'});
        
        $('.fancybox-inner').find('.prompt-add-status').show();
        $('.fancybox-inner').find('.prompt-add-status').html(renderStatus((atom ? atom.id : undefined), isSetMember, data));
        
        // Don't show edit field if this is a computed non-atom value, or if it's a non-empty collection
        if (canEdit && (isSetMember || !formulas[atom.formula].isCollection || atom.args.length == 0)) {
            $('.fancybox-inner').find('.prompt-add-value').show();
            $('.fancybox-inner').find('.prompt-add-type-explanation').show();
            $('.fancybox-inner').find('.prompt-add-type-radio').show();
            $('.fancybox-inner').find('.prompt-add-type-radio-auto').show();
            $('.fancybox-inner').find('.prompt-add-type-radio-string-single').show();
            $('.fancybox-inner').find('.prompt-add-type-radio-string-single-change').show();
            $('.fancybox-inner').find('input[name="type"][value="auto"]').prop('checked', true);
            $('.fancybox-inner').find('.prompt-add-button-use').show();
            if (!isSetMember) {
                $('.fancybox-inner').find('.prompt-add-button-formula').show();
                $('.fancybox-inner').find('input[name="formula"]').val('Replace above value with formula');
            }
            if (isSetMember || !formulas[atom.formula].isComputed) {
                $('.fancybox-inner').find('input[name="use"]').val('Change value');
                var valueText;
                if (data === null) {
                    valueText = 'null';
                } else {
                    if (typeof data == 'object') {
                        valueText = {
                            list: '[]',
                            set: '()',
                            dictionary: '{}'
                        }[data.collectionType];
                    } else {
                        valueText = '' + data;
                    }
                }
                $('.fancybox-inner').find('textarea[name="value"]').val(valueText);
                if (typeof data == 'string') {
                    $('.fancybox-inner').find('input[name="type"][value="string-single"]').prop('checked', true);
                }
            } else {
                $('.fancybox-inner').find('input[name="use"]').val('Replace formula with above value');
                $('.fancybox-inner').find('input[name="formula"]').val('Change formula');
                if (formulas[atom.formula].hasOwnProperty('promptArguments')) {
                    $('.fancybox-inner').find('.prompt-add-button-arguments').show();
                }
            }
            if (!bowser.ios && !bowser.android) {
                $('.fancybox-inner').find('textarea[name="value"]').select();
            }
        }
        if (atom && formulas[atom.formula].isCollection && atom.args.length > 0) {
            $('.fancybox-inner').find('.prompt-add-button-delete-contents').show();
        }
        if (canEdit && !isSetMember && !formulas[atom.formula].isComputed) {
            $('.fancybox-inner').find('.prompt-add-button-transform').show();
        }
        if (canEdit && !isSetMember && formulas[atom.formula].isComputed) {
            $('.fancybox-inner').find('.prompt-add-button-convert').show();
        }
        $('.fancybox-inner').find('.prompt-add-button-json').show();
        
        var validateInputChange = function() {
            validateInput(setParent ? true : false, undefined, true);
        };
        
        $('.fancybox-inner').find('textarea[name="value"]').on('keyup', function(event) {
            if (event.keyCode == 27) {
                $.fancybox.close();
            }
            validateInputChange();
        });
        $('.fancybox-inner').find('input[name="type"]').on('change', function() {
            validateInputChange();
        });
        validateInputChange();
        
        var useButton = function() {
            
            var action = $.extend(true, {}, actionTemplate);
            action.id = generateActionId();
            action.basedOn = actionsHistoryPointer;
            
            var result = validateInput(setParent ? true : false, undefined, true);
            var type = result.values[0].type;
            var value = result.values[0].value;
            
            action.description = 'Changed ' + {
                'set': 'set',
                'literalBoolean': 'boolean',
                'literalNull': 'null',
                'literalUndefined': 'undefined',
                'literalNumber': 'number',
                'literalStringQuoted': 'string',
                'literalString': 'string',
                'json': 'JSON'
            }[type] + ' value';
            action.descriptionPast = action.description.replace(/Change/, 'changed a');
            
            if (setParent) {
                // First delete old value
                var newElements = cloneArrayWithoutExcludingUndefined(setParent.args);
                for (var i = 0; i < newElements.length; i++) {
                    if (newElements[i] === data) {
                        newElements.splice(i, 1);
                        i--;
                    } else {
                        if (typeof newElements[i] == 'object' && typeof data == 'object' && newElements[i] !== null && data !== null) { // cover case for undefined
                            newElements.splice(i, 1);
                            i--;
                        }
                    }
                }
                
                // Then insert new value, sort, and scan for duplicates
                newElements.push(value);
                sanitizeSetData(newElements);
                
                action.steps.push({
                    predicate: 'change',
                    atomId: setParent.id,
                    formula: 'set',
                    args: newElements
                });
            } else {
                if ($.inArray(type, ['set', 'literalBoolean', 'literalNull', 'literalUndefined', 'literalNumber', 'literalStringQuoted', 'literalString']) != -1) {
                    action.steps.push({
                        predicate: 'change',
                        atomId: atom.id,
                        formula: (type == 'literalStringQuoted' ? 'literalString' : type),
                        args: {
                            'set': value,
                            'literalBoolean': [value],
                            'literalNull': [],
                            'literalUndefined': [],
                            'literalNumber': [value],
                            'literalStringQuoted': [value],
                            'literalString': [value]
                        }[type]
                    });
                } else {
                    // is 'json'
                    if ($.isArray(value)) {
                        action.steps.push({
                            predicate: 'change',
                            atomId: atom.id,
                            formula: 'list',
                            args: []
                        });
                    } else {
                        action.steps.push({
                            predicate: 'change',
                            atomId: atom.id,
                            formula: 'dictionary',
                            args: []
                        });
                    }
                    $.each(value, function(i, v) {
                        insertDataFromJsonIterate(atom.id, i, v, action.steps);
                    });
                }
            }
            
            actionsHistory[action.id] = action;
            $.fancybox.close();
            processAction(actionsHistory[action.id]);
            refresh();
        };
        
        $('.fancybox-inner').find('input[name="use"]').on('click', function() {
            useButton();
        });
        
        var deleteContents = function() {
            
            var action = $.extend(true, {}, actionTemplate);
            action.id = generateActionId();
            action.basedOn = actionsHistoryPointer;
            action.description = 'Delete ' + atom.formula + ' contents';
            action.descriptionPast = 'deleted a ' + atom.formula + ' element contents';
            
            if (atom.formula == 'set') {
                action.steps.push({
                    predicate: 'change',
                    atomId: atom.id,
                    formula: 'set',
                    args: []
                });
            }
            if (atom.formula == 'list' || atom.formula == 'dictionary') {
                $.each(atom.args, function(i, item) {
                    action.steps.push({
                        predicate: 'delete',
                        atomId: (atom.formula == 'list' ? item : item.value)
                    });
                });
            }
            
            actionsHistory[action.id] = action;
            $.fancybox.close();
            processAction(actionsHistory[action.id]);
            refresh();
        };
        
        $('.fancybox-inner').find('input[name="delete-contents"]').on('click', function() {
            deleteContents();
        });
        
        $('.fancybox-inner').find('input[name="json"]').on('click', function() {
            $.fancybox.close();
            $.fancybox($('.prompt-export').prop('outerHTML'), {openEffect: 'none', closeEffect: 'none'});
            
            var result;
            if (atom) {
                result = exportJson(atom.data);
            } else {
                result = exportJson(data);
            }
            
            $('.fancybox-inner').find('textarea[name="export"]').val(JSON.stringify(result.json, null, 2));
            if (result.encounteredSet) {
                $('.fancybox-inner').find('.prompt-export-sets').show();
            }
            if (result.encounteredUndefined) {
                $('.fancybox-inner').find('.prompt-export-undefined').show();
            }
        });
        
        $('.fancybox-inner').find('input[name="arguments"]').on('click', function() {
            $.fancybox.close();
            pickFormulaArguments(atom.formula, atom.args, function(inputs) {
                var newArgs = $.extend(true, [], atom.args);
                var inputPointer = 0;
                $.each(formulas[atom.formula].promptArguments, function(i, arg) {
                    if (arg != '') {
                        newArgs[i] = inputs[inputPointer];
                        inputPointer++;
                    }
                });
                
                var action = $.extend(true, {}, actionTemplate);
                action.id = generateActionId();
                action.basedOn = actionsHistoryPointer;
                action.description = 'Change ' + atom.formula + ' formula arguments';
                action.descriptionPast = 'changed ' + atom.formula + ' formula arguments';
                action.steps.push({
                    predicate: 'change',
                    atomId: atom.id,
                    formula: atom.formula,
                    args: newArgs
                });
                
                actionsHistory[action.id] = action;
                processAction(actionsHistory[action.id]);
                refresh();
            }, function() {});
        });
        
        $('.fancybox-inner').find('input[name="formula"]').on('click', function() {
            pickFormula(true, false, atom.id, undefined, undefined);
        });
        
        $('.fancybox-inner').find('input[name="transform"]').on('click', function() {
            pickFormula(true, true, atom.id, undefined, undefined);
        });
        
        $('.fancybox-inner').find('input[name="convert"]').on('click', function() {
            $.fancybox.close();
            
            var action = insertDataFromCalculated(atom.id, atom.data, 'Convert ' + atom.formula + ' formula to data', 'converted ' + atom.formula + ' formula to data');
            processAction(actionsHistory[action.id]);
            refresh();
        });
    }
};

var validateInput = function(isInSet, atomIdToCheckCollisions, isChange) {
    
    var validateLine = function(line, isInSet) {
        var trimmed = $.trim(line);
        if (!isInSet) {
            if ((trimmed.substr(0, 1) == '[' && trimmed.slice(-1) == ']') || (trimmed.substr(0, 1) == '{' && trimmed.slice(-1) == '}')) {
                if (isJson(trimmed)) {
                    return {type: 'json', value: JSON.parse(trimmed)};
                }
            }
            if (trimmed.substr(0, 1) == '(' && trimmed.slice(-1) == ')') {
                var setConverted = '[' + trimmed.slice(1).slice(0, -1) + ']';
                if (isJson(setConverted)) {
                    var parsed = JSON.parse(setConverted);
                    var invalid = false;
                    $.each(parsed, function(i, v) {
                        if (typeof v == 'object' && v !== null) {
                            invalid = true;
                        }
                    });
                    if (!invalid) {
                        sanitizeSetData(parsed);
                        return {type: 'set', value: parsed};
                    }
                }
            }
        }
        if (trimmed.toLowerCase() == 'true') {
            return {type: 'literalBoolean', value: true};
        }
        if (trimmed.toLowerCase() == 'false') {
            return {type: 'literalBoolean', value: false};
        }
        if (trimmed.toLowerCase() == 'null') {
            return {type: 'literalNull', value: null};
        }
        if (trimmed.toLowerCase() == 'undefined') {
            return {type: 'literalUndefined', value: {specialType: 'undefined'}};
        }
        if (!isNaN(trimmed) && trimmed.length > 0) {
            return {type: 'literalNumber', value: +trimmed};
        }
        if (trimmed.substr(0, 1) == '"' && trimmed.slice(-1) == '"') {
            var quotedConverted = trimmed;
            if (isJson(quotedConverted)) {
                return {type: 'literalStringQuoted', value: JSON.parse(quotedConverted)};
            }
        }
        return {type: 'literalString', value: line};
    };
    
    var keys;
    var values;
    var lines;
    $('.fancybox-inner').find('.prompt-add-type-explanation').hide();
    if ($('.fancybox-inner').find('input[name="type"]:checked').val() == 'string-single') {
        keys = [$('.fancybox-inner').find('textarea[name="key"]').val()];
        values = [{type: 'literalString', value: $('.fancybox-inner').find('textarea[name="value"]').val()}];
    }
    if ($('.fancybox-inner').find('input[name="type"]:checked').val() == 'string-multi') {
        lines = $('.fancybox-inner').find('textarea[name="value"]').val().split('\n');
        values = [];
        $.each(lines, function(i, line) {
            values.push({type: 'literalString', value: line});
        });
    }
    if ($('.fancybox-inner').find('input[name="type"]:checked').val() == 'auto') {
        if (isChange) { // If a change, multi-line is disallowed
            lines = [$('.fancybox-inner').find('textarea[name="value"]').val()];
        } else {
            if ($('.fancybox-inner').find('textarea[name="value"]').val().split('\n').length > 1 && isJson($('.fancybox-inner').find('textarea[name="value"]').val())) {
                // If the entire multi-line input is a single valid JSON, interpret it that way
                lines = [$('.fancybox-inner').find('textarea[name="value"]').val()];
            } else {
                lines = $('.fancybox-inner').find('textarea[name="value"]').val().split('\n');
            }
        }
        values = [];
        $.each(lines, function(i, line) {
            values.push(validateLine(line, isInSet));
        });
        
        var typeDetected = undefined;
        var typeMapping = {
            'json': 'JSON',
            'set': 'Set',
            'literalBoolean': 'Boolean',
            'literalNull': 'Null',
            'literalUndefined': 'Undefined',
            'literalNumber': 'Number',
            'literalStringQuoted': 'Quoted string',
            'literalString': 'String'
        };
        $.each(values, function(i, value) {
            var newType = typeMapping[value.type];
            if (typeDetected === undefined) {
                typeDetected = newType;
            } else {
                if (typeDetected != newType) {
                    typeDetected = 'Mixed';
                }
            }
        });
        $('.fancybox-inner').find('.prompt-add-type-explanation').show();
        if (values.length == 1) {
            $('.fancybox-inner').find('.prompt-add-type-explanation').text('Type detected: ' + typeDetected);
        } else {
            $('.fancybox-inner').find('.prompt-add-type-explanation').text('Type detected: Multi-line of ' + typeDetected);
        }
    }
    
    var isKeyMismatchError = false;
    $('.fancybox-inner').find('.prompt-add-key-mismatch').hide();
    $('.fancybox-inner').find('.prompt-add-collision').hide();
     // Only check if we're using keys at all
    if (atomIdToCheckCollisions) {
        // Check for mismatch of number of keys and number of values
        if ($.inArray($('.fancybox-inner').find('input[name="type"]:checked').val(), ['string-multi', 'auto']) != -1) {
            keys = $('.fancybox-inner').find('textarea[name="key"]').val().split('\n');
            
            // If the only key/value count mismatch is a blank line at the end of the keys, kill the blank line
            if (keys.length - 1 == values.length && keys.slice(-1)[0] == '') {
                keys.pop();
            }
            
            if (keys.length != values.length) {
                isKeyMismatchError = true;
            }
        }
    } else {
        keys = [];
    }
    
    if (!isKeyMismatchError) {
        var isKeyCollisionError = false;
        // Only check if we're using keys at all
        if (atomIdToCheckCollisions) {
            
            // Check for duplicate keys in the input
            var sortedKeys = $.extend(true, [], keys);
            sortedKeys.sort();
            for (var i = 0; i < sortedKeys.length - 1; i++) {
                if (sortedKeys[i] == sortedKeys[i + 1]) {
                    isKeyCollisionError = true;
                }
            }
            
            // Check for key collisions in the target dictionary
            var keysTarget = atoms[atomIdToCheckCollisions].args;
            $.each(keysTarget, function(i, keyTarget) {
                if ($.inArray(keyTarget.key, keys) != -1) {
                    isKeyCollisionError = true;
                }
            });
        }
        
        if (!isKeyCollisionError) {
            return {keys: keys, values: values};
        } else {
            $('.fancybox-inner').find('.prompt-add-collision').show();
            return false;
        }
    } else {
        $('.fancybox-inner').find('.prompt-add-key-mismatch').show();
        return false;
    }
};

var pickFormula = function(isChange, isTransform, atomId, parentId, parentPosition) {
    $.fancybox.close();
    $.fancybox($('.prompt-formula').prop('outerHTML'), {openEffect: 'none', closeEffect: 'none'});
    
    $.each(formulas, function(formulaName, formula) {
        if (formulas[formulaName].isComputed) {
            $('.fancybox-inner').find('.formula-chooser').append('<p><input type="button" name="formula-' + formulaName + '" value="' + formulaName + '" data-formula="' + formulaName + '"></input><br/><span class="formula-description">' + formula.description + '</span></p>');
        }
    });
    $('.fancybox-inner').find('input[type="button"]').on('click', function() {
        pickTheFormula($(this));
    });
    
    var pickTheFormula = function($button) {
        var formula = $button.data('formula');
        
        formulaChoosingIsChange = isChange;
        formulaChoosingIsTransform = isTransform;
        formulaChoosingAtomId = atomId;
        formulaChoosingParentId = parentId;
        formulaChoosingParentPosition = parentPosition;
        formulaChoosingFormula = formula;
        formulaChoosingAtomArgs = [];
        
        $('.element.atom-id-' + $(this).data('atom')).addClass('element-formula-chooser');
        
        $('.status').show();
        $('.status').removeClass('status-top');
        $('.status .status-text').html('');
        $('.status .formula-arguments-explain').show();
        $('.status .status-formula-type').text(formula);
        $('.status .status-formula-arguments-count').text(formulas[formula].minArguments == formulas[formula].maxArguments ? formulas[formula].minArguments : formulas[formula].minArguments + '-' + formulas[formula].maxArguments);
        $('.status .formula-button-done').show();
        $('.status input[name="done"]').prop('disabled', true);
        $('.status .formula-button-cancel').show();
        $('.status .formula-button-move').show();
        if (formulas[formula].minArguments == 0) {
            $('.status .formula-button-done-caption').show();
            $('.status input[name="done"]').prop('disabled', false);
        }
        
        $.fancybox.close();
        uiState = 'formulaChoosing';
        $('.menu').each(function() {
            if (!$(this).hasClass('menu-disabled') && !$(this).hasClass('menu-collapse') && !$(this).hasClass('menu-expand') && !$(this).hasClass('menu-wrap')) {
                $(this).addClass('menu-disabled');
                $(this).addClass('menu-disabled-formula-choosing');
            }
        });
        
        if (isTransform) {
            formulaChoosingTransformState = saveState();
            
            pickFormulaElement($('.atom-id-' + formulaChoosingAtomId), true);
        }
    };
};

var pickFormulaElement = function($element, forceAllowSource) {
    if (($element.data('atom') != formulaChoosingAtomId || forceAllowSource) && $.inArray($element.data('atom'), formulaChoosingAtomArgs) == -1) {
        var atomId = $element.data('atom');
        
        formulaChoosingAtomArgs.push(atomId);
        $element.removeClass('element-formula-target-allowed');
        $element.addClass('element-formula-selected');
        
        if (formulas[formulaChoosingFormula].minArguments == formulaChoosingAtomArgs.length) {
            $('.status .formula-button-done-caption').show();
            $('.status input[name="done"]').prop('disabled', false);
        }
        
        if (formulas[formulaChoosingFormula].maxArguments == formulaChoosingAtomArgs.length) {
            $('.status input[name="done"]').trigger('click');
        } else {
            if (formulas[formulaChoosingFormula].hasOwnProperty('promptArguments') &&
                formulas[formulaChoosingFormula].promptArguments.length >= formulaChoosingAtomArgs.length &&
                formulas[formulaChoosingFormula].promptArguments[formulaChoosingAtomArgs.length] != '')
            {
                $('.status').hide();
                var previousArguments = [];
                $.each(formulas[formulaChoosingFormula].promptArguments, function(i, arg) {
                    previousArguments.push('');
                });
                pickFormulaArguments(formulaChoosingFormula, previousArguments, function(inputs) {
                    $.each(inputs, function(i, arg) {
                        formulaChoosingAtomArgs.push(arg);
                    });
                    pickFormulaDone();
                }, function() {
                    pickFormulaCancel();
                });
            }
        }
    }
};

var pickFormulaArguments = function(formula, argumentValues, ok, cancel) {
    $.fancybox($('.prompt-formula-arguments').prop('outerHTML'), {openEffect: 'none', closeEffect: 'none', modal: true});
    $.each(formulas[formula].promptArguments, function(i, arg) {
        if (arg != '') {
            var $prompt = $('<p><label>' + arg + '<br/><input type="text" name="argument-' + i + '"></input></label></p>');
            $prompt.find('input').val(argumentValues[i]);
            if (bowser.ios) {
                $prompt.find('input').addClass('ios');
            }
            $('.fancybox-inner .prompt-formula-arguments-fields').append($prompt);
        }
    });
    if (formulas[formula].promptDescription) {
        $('.fancybox-inner .prompt-formula-arguments-fields').append(formulas[formula].promptDescription);
    }
    $('.fancybox-inner input[name="cancel"]').on('click', function() {
        $.fancybox.close();
        cancel();
    });
    $('.fancybox-inner input[name="use"]').on('click', function() {
        var inputs = [];
        $.each(formulas[formula].promptArguments, function(i, arg) {
            if (arg != '') {
                inputs.push($('.fancybox-inner input[name="argument-' + i + '"]').val());
            }
        });
        $.fancybox.close();
        ok(inputs);
    });
};

var pickFormulaDone = function() {
    if (formulaChoosingIsTransform) {
        var action = $.extend(true, {}, actionTemplate);
        var newAtomId = generateAtomId();
        action.basedOn = actionsHistoryPointer;
        action.steps.push({
            predicate: 'create',
            atomId: newAtomId,
            childOf: '0',
            position: atoms['0'].args.length,
            formula: formulaChoosingFormula,
            args: $.extend(true, [], formulaChoosingAtomArgs)
        });
        actionsHistory[action.id] = action;
        processAction(actionsHistory[action.id]);
        recalculate();
        
        action = insertDataFromCalculated(formulaChoosingAtomId, atoms[newAtomId].data, '', '');
        
        var steps = $.extend(true, [], action.steps);
        steps[0].atomId = formulaChoosingAtomId;
        
        loadState(formulaChoosingTransformState);
        formulaChoosingTransformState = undefined; // just to free up memory
        
        action = $.extend(true, {}, actionTemplate);
        action.id = generateActionId();
        action.basedOn = actionsHistoryPointer;
        action.description = 'Transform in place using ' + formulaChoosingFormula + ' formula';
        action.descriptionPast = 'transformed in place using ' + formulaChoosingFormula + ' formula';
        if (atoms[formulaChoosingAtomId].formula == 'dictionary' || atoms[formulaChoosingAtomId].formula == 'list') {
            $.each(atoms[formulaChoosingAtomId].args, function(i, item) {
                action.steps.push({
                    predicate: 'delete',
                    atomId: (atoms[formulaChoosingAtomId].formula == 'list' ? item : item.value)
                });
            });
        }
        $.each(steps, function(i, step) {
            action.steps.push(step);
        });
        actionsHistory[action.id] = action;
        processAction(actionsHistory[action.id]);
        refresh();
    } else {
        var action = $.extend(true, {}, actionTemplate);
        action.id = generateActionId();
        action.basedOn = actionsHistoryPointer;
        
        if (formulaChoosingIsChange) {
            action.steps.push({
                predicate: 'change',
                atomId: formulaChoosingAtomId,
                formula: formulaChoosingFormula,
                args: $.extend(true, [], formulaChoosingAtomArgs)
            });
            action.description = 'Change ' + formulaChoosingFormula + ' formula';
            action.descriptionPast = 'changed a ' + formulaChoosingFormula + ' formula';
        } else {
            action.steps.push({
                predicate: 'create',
                atomId: generateAtomId(),
                childOf: formulaChoosingParentId,
                position: formulaChoosingParentPosition,
                formula: formulaChoosingFormula,
                args: $.extend(true, [], formulaChoosingAtomArgs)
            });
            action.description = 'Add ' + formulaChoosingFormula + ' formula';
            action.descriptionPast = 'added a ' + formulaChoosingFormula + ' formula';
        }

        actionsHistory[action.id] = action;
        processAction(actionsHistory[action.id]);
        refresh();
    }
    
    pickFormulaCancel();
};

var pickFormulaCancel = function() {
    uiState = 'normal';
    $('.element').removeClass('element-formula-chooser');
    $('.element').removeClass('element-formula-selected');
    $('.element').removeClass('element-formula-target-allowed');
    $('.element').removeClass('element-formula-target-disallowed');
    $('.status .formula-arguments-explain').hide();
    $('.status .formula-button-done').hide();
    $('.status .formula-button-cancel').hide();
    $('.status .formula-button-move').hide();
    $('.status .formula-button-done-caption').hide();
    $('.status').hide();
    $('.menu').each(function() {
        if ($(this).hasClass('menu-disabled-formula-choosing')) {
            $(this).removeClass('menu-disabled');
            $(this).removeClass('menu-disabled-formula-choosing');
        }
    });
};

var pickFormulaMove = function() {
    if ($('.status').hasClass('status-top')) {
        $('.status').removeClass('status-top');
    } else {
        $('.status').addClass('status-top');
    }
};

var addColumn = function() {
    $.fancybox($('.prompt-add-simple').prop('outerHTML'), {openEffect: 'none', closeEffect: 'none'});
    
    var create = function(type) {
        var action = $.extend(true, {}, actionTemplate);
        action.id = generateActionId();
        action.basedOn = actionsHistoryPointer;
        action.description = 'Add ' + type + ' in new column';
        action.descriptionPast = 'added a ' + type + ' in a new column';
        action.steps.push({
            predicate: 'create',
            atomId: generateAtomId(),
            childOf: '0',
            position: atoms['0'].args.length,
            formula: type,
            args: []
        });
        actionsHistory[action.id] = action;
        $.fancybox.close();
        processAction(actionsHistory[action.id]);
        refresh();
    };
    $('.fancybox-inner input[name="list"]').on('click', function() {
        create('list');
    });
    $('.fancybox-inner input[name="set"]').on('click', function() {
        create('set');
    });
    $('.fancybox-inner input[name="dictionary"]').on('click', function() {
        create('dictionary');
    });
    
    $('.fancybox-inner input[name="other"]').on('click', function() {
        $.fancybox.close();
        add($('.button-add-column'));
    });
};

var moveMouseDown = function($button) {
    if (uiState == 'normal') {
        $moveDraggingElement = $button.closest('.element');
        moveDraggingElementOffsetX = $moveDraggingElement.offset().left;
        moveDraggingElementOffsetY = $moveDraggingElement.offset().top;
        if ($moveDraggingElement.data('container')) {
            $moveDraggingElementContainer = $('.element-container-id-' + $moveDraggingElement.data('container'));
            moveDraggingElementContainerOffsetX = $moveDraggingElementContainer.offset().left + 2;
            moveDraggingElementContainerOffsetY = $moveDraggingElementContainer.offset().top - $moveDraggingElement.outerHeight() - 2;
        }
        
        $moveDraggingElement.addClass('element-drag');
        if ($moveDraggingElementContainer) {
            $moveDraggingElementContainer.find('.element').addClass('element-drag');
        }
        
        $moveDraggingElement.trigger('mouseleave');
        uiState = 'moveDragging';
        $(document).trigger('mousemove');
    }
};

var moveMouseMove = function(event) {
    if (uiState == 'moveDragging') {
        var positionX = event.pageX;
        var positionY = event.pageY;
        var touch = (event.originalEvent && event.originalEvent.touches && event.originalEvent.touches[0]) || (event.originalEvent && event.originalEvent.changedTouches && event.originalEvent.changedTouches[0]);
        if (touch) {
            positionX = touch.pageX;
            positionY = touch.pageY;
        }
        
        $moveDraggingElement.css('top', positionY - 12 - moveDraggingElementOffsetY);
        $moveDraggingElement.css('left', positionX - 12 - moveDraggingElementOffsetX);
        if ($moveDraggingElementContainer) {
            $moveDraggingElementContainer.css('top', positionY - 12 - moveDraggingElementContainerOffsetY);
            $moveDraggingElementContainer.css('left', positionX - 12 - moveDraggingElementContainerOffsetX);
        }
        document.getSelection().removeAllRanges();
        
        if (touch) {
            $('.element, .column-placeholder, .scroll').each(function() {
                var top = $(this).offset().top;
                var left = $(this).offset().left;
                if (top <= positionY && top + $(this).outerHeight() >= positionY && left <= positionX && left + $(this).outerWidth() >= positionX && !$(this).hasClass('element-drag')) {
                    if ($(this).hasClass('scroll')) {
                        $(this).trigger('mousemove');
                    } else {
                        $(this).trigger('mouseenter');
                    }
                } else {
                    if ($(this).hasClass('element-hover')) {
                        $(this).trigger('mouseleave');
                    }
                }
            });
        }

        var scrollShuttle = (positionY - $(window).scrollTop()) / $(window).height();
        if (scrollShuttle < 0.2 || scrollShuttle > 0.8) {
            scrollSpeed = (0.2 - Math.min(1 - scrollShuttle, scrollShuttle - 0)) * 1000;
            if (scrollShuttle < 0.2) {
                scrollSpeed *= -1;
            }
            $(window).scrollTop($(window).scrollTop() + scrollSpeed);
        }
    }
    
    // Mouse movement triggers "light" activity detector - cap the check-for-update interval at 15 seconds
    if (new Date().getTime() - lastTimeResetUpdateInterval > 2100000) {
        lastTimeResetUpdateInterval = new Date().getTime() - 2100000;
    }
};

var moveMouseUp = function(event) {
    if (uiState == 'moveDragging') {
        $moveDraggingElement.css('top', '');
        $moveDraggingElement.css('left', '');
        $moveDraggingElement.removeClass('element-drag');
        $moveDraggingElement.removeClass('element-drag-nodrop');
        if ($moveDraggingElementContainer) {
            $moveDraggingElementContainer.css('top', '');
            $moveDraggingElementContainer.css('left', '');
            $moveDraggingElementContainer.find('.element-drag').removeClass('element-drag');
        }
        
        var delayProcessAction = false;
        
        var $target = $('.element-hover');
        if ($('.element-hover').length > 0) {
            $target.trigger('mouseleave');
            
            var data;
            var action = $.extend(true, {}, actionTemplate);
            action.basedOn = actionsHistoryPointer;
            
            if ($moveDraggingElement.data('atom')) {
                if (formulas[atoms[$moveDraggingElement.data('atom')].formula].isComputed) {
                    action.description = 'Move element with ' + atoms[$moveDraggingElement.data('atom')].formula + ' formula';
                } else {
                    action.description = 'Move ' + formulaNames[atoms[$moveDraggingElement.data('atom')].formula] + ' value';
                }
            } else {
                action.description = 'Move ' + getType($moveDraggingElement.data('data')[0]) + ' value';
            }
            action.descriptionPast = action.description.replace(/Move/, 'moved a');
            
            var deleteOriginalAtom = false;
            var deleteElementFromSet = false;
            var insertElementIntoSet = false;
            var createElement = false;
            
            // scenarios this function needs to account for:
            // 
            // move literal atom into set
            // move from set to set
            // move from set to other collection (prompt key if dictionary)
            // move from collection to collection (prompt key if target dictionary and source not; check key collision if both dictionary and prompt if so)
            
            // When checking whether target is a set member, also consider case where the target is the set's closing parenthesis
            if ($moveDraggingElement.data('atom') && ($target.data('set-parent') || (atoms[$target.data('atom')].formula == 'set' && $target.hasClass('collection-close')))) {
                deleteOriginalAtom = true;
            }
            if ($moveDraggingElement.data('set-parent')) {
                deleteElementFromSet = true;
            }
            if ($target.data('set-parent') || (atoms[$target.data('atom')].formula == 'set' && $target.hasClass('collection-close'))) {
                insertElementIntoSet = true;
            }
            if ($moveDraggingElement.data('set-parent') && $target.data('atom')) {
                createElement = true;
            }
            
            // situations in which we need to locate the target's parent
            var position;
            var childOf;
            if (createElement || (!deleteOriginalAtom && !deleteElementFromSet && !insertElementIntoSet && !createElement)) {
                var targetId = $target.data('atom');
                // Case where target is closing bracket
                if ($target.hasClass('collection-close')) {
                    childOf = targetId;
                    if (atoms[$target.data('atom')].formula == 'list') {
                        position = atoms[$target.data('atom')].args.length;
                    }
                } else {
                    position = $target.data('key')[0];
                    // More typical case where target is sub-element of the collection
                    $.each(atoms, function(i, atom) {
                        if (atom.formula == 'list') {
                            $.each(atom.args, function(j, item) {
                                if (item == targetId) {
                                    childOf = atom.id;
                                }
                            });
                        }
                        if (atom.formula == 'dictionary') {
                            $.each(atom.args, function(j, item) {
                                if (item.value == targetId) {
                                    childOf = atom.id;
                                }
                            });
                        }
                    });
                }
            }
            
            // Situations in which we need to insert into a set
            var dontMoveSameSet = false;
            if (insertElementIntoSet) {
                var targetSetAtomId;
                var newSetArgs;
                if ($target.hasClass('collection-close')) {
                    targetSetAtomId = $target.data('atom');
                } else {
                    targetSetAtomId = $target.data('set-parent');
                }
                // Check if we are trying to move from the same set into itself; don't do anything in this case
                if (deleteElementFromSet) {
                    if (targetSetAtomId == $moveDraggingElement.data('set-parent')) {
                        dontMoveSameSet = true;
                    }
                }
            }
            
            if (deleteOriginalAtom) {
                action.steps.push({
                    predicate: 'delete',
                    atomId: $moveDraggingElement.data('atom')
                });
            }
            if (deleteElementFromSet) {
                if (!dontMoveSameSet) {
                    newSetArgs = cloneArrayWithoutExcludingUndefined(atoms[$moveDraggingElement.data('set-parent')].args);
                    data = $moveDraggingElement.data('data')[0];
                    for (var i = 0; i < newSetArgs.length; i++) {
                        if (newSetArgs[i] === data) {
                            newSetArgs.splice(i, 1);
                            i--;
                        } else {
                            if (typeof data == 'object' && typeof newSetArgs[i] == 'object' && data !== null && newSetArgs[i] !== null) { // cover case for undefined
                                newSetArgs.splice(i, 1);
                                i--;
                            }
                        }
                    }
                    action.steps.push({
                        predicate: 'change',
                        atomId: $moveDraggingElement.data('set-parent'),
                        formula: 'set',
                        args: newSetArgs
                    });
                }
            }
            if (insertElementIntoSet) {
                if (!dontMoveSameSet) {
                    newSetArgs = cloneArrayWithoutExcludingUndefined(atoms[targetSetAtomId].args);
                    data = $moveDraggingElement.data('data')[0];
                    var alreadyPresent = false;
                    for (var i = 0; i < newSetArgs.length; i++) {
                        if (newSetArgs[i] === data) {
                            alreadyPresent = true;
                        } else {
                            if (typeof newSetArgs[i] == 'object' && typeof data == 'object' && newSetArgs[i] !== null && data !== null) {
                                alreadyPresent = true;
                            }
                        }
                    }
                    if (!alreadyPresent) {
                        newSetArgs.push(data);
                        newSetArgs.sort(dataCompare);
                        action.steps.push({
                            predicate: 'change',
                            atomId: targetSetAtomId,
                            formula: 'set',
                            args: newSetArgs
                        });
                    }
                }
            }
            if (createElement) {
                if (atoms[childOf].type == 'dictionary') {
                    data = $moveDraggingElement.data('data')[0];
                    promptKey(childOf, undefined, 'prompt-key-no-collision', 'prompt-key-collision', function(newKey) {
                        action.steps.push({
                            predicate: 'create',
                            atomId: generateAtomId(),
                            childOf: childOf,
                            position: newKey,
                            formula: {
                                'number': 'literalNumber',
                                'string': 'literalString',
                                'boolean': 'literalBoolean',
                                'null': 'literalNull',
                                'undefined': 'literalUndefined'
                            }[getType(data)],
                            args: [data]
                        });
                        action.id = generateActionId();
                        actionsHistory[action.id] = action;
                        processAction(actionsHistory[action.id]);
                        refresh();
                    });
                    delayProcessAction = true;
                } else { // list
                    action.steps.push({
                        predicate: 'create',
                        atomId: generateAtomId(),
                        childOf: childOf,
                        position: position,
                        formula: {
                            'number': 'literalNumber',
                            'string': 'literalString',
                            'boolean': 'literalBoolean',
                            'null': 'literalNull',
                            'undefined': 'literalUndefined'
                        }[getType(data)],
                        args: [data]
                    });
                }
            }
            
            // Simple move
            if (!deleteOriginalAtom && !deleteElementFromSet && !insertElementIntoSet && !createElement) {
                var sourceId = $moveDraggingElement.data('atom');
                // Don't do anything if moving from the same dictionary into itself.
                // List is ok though: We might be changing the order.
                var sameDictionaryDontMove = false;
                if (atoms[childOf].formula == 'dictionary' && typeof $moveDraggingElement.data('key')[0] == 'string') {
                    $.each(atoms[childOf].args, function(i, item) {
                        if (item.value == sourceId) {
                            sameDictionaryDontMove = true;
                        }
                    });
                }
                if (!sameDictionaryDontMove) {
                    if (atoms[childOf].formula == 'dictionary') {
                        var currentKey = undefined;
                        if (typeof $moveDraggingElement.data('key')[0] == 'string') {
                            currentKey = $moveDraggingElement.data('key')[0];
                        }
                        promptKey(childOf, currentKey, 'prompt-key-no-collision', 'prompt-key-collision', function(newKey) {
                            action.steps.push({
                                predicate: 'move',
                                atomId: sourceId,
                                childOf: childOf,
                                position: newKey
                            });
                            action.id = generateActionId();
                            actionsHistory[action.id] = action;
                            processAction(actionsHistory[action.id]);
                            refresh();
                        });
                        delayProcessAction = true;
                    } else {
                        // If moving within the same list, and the new position is after the old position, need to offset the target position by 1
                        var sameListAdjustOffest = false;
                        $.each(atoms[childOf].args, function(i, item) {
                            if (item == sourceId && i < position) {
                                sameListAdjustOffest = true;
                            }
                        });
                        action.steps.push({
                            predicate: 'move',
                            atomId: sourceId,
                            childOf: childOf,
                            position: position + (sameListAdjustOffest ? -1 : 0)
                        });
                    }
                }
            }
            
            if (!delayProcessAction && action.steps.length > 0) {
                action.id = generateActionId();
                actionsHistory[action.id] = action;
                processAction(actionsHistory[action.id]);
                refresh();
            }
        }
        
        uiState = 'normal';
        $moveDraggingElement = undefined;
        $moveDraggingElementContainer = undefined;
    }
};

var renameKey = function($key) {
    var $element = $key.closest('.element');
    $element.trigger('mouseleave');
    var atomId = $element.data('atom');
    var atomIdToCheckCollisions;
    $.each(atoms, function(i, atom) {
        if (atom.formula == 'dictionary') {
            $.each(atom.args, function(j, item) {
                if (item.value == atomId) {
                    atomIdToCheckCollisions = atom.id;
                }
            });
        }
    });
    promptKey(atomIdToCheckCollisions, $element.data('key')[0], 'prompt-key-rename', 'prompt-key-rename-collision', function(newKey) {
        var action = $.extend(true, {}, actionTemplate);
        action.basedOn = actionsHistoryPointer;
        action.id = generateActionId();
        action.description = 'Rename dictionary key';
        action.descriptionPast = 'renamed a dictionary key';
        action.steps.push({
            predicate: 'move',
            atomId: atomId,
            childOf: atomIdToCheckCollisions,
            position: newKey
        });
        actionsHistory[action.id] = action;
        processAction(actionsHistory[action.id]);
        refresh();
    });
};

var promptKey = function(atomIdToCheckCollisions, currentKey, firstMessageType, secondMessageType, successCallback) {
    // First, check to see if the currentKey collides. If not, don't even prompt the user.
    // But, we have to prompt if currentKey is undefined.
    var foundCollision = false;
    if (typeof currentKey == 'string') {
        $.each(atoms[atomIdToCheckCollisions].args, function(i, item) {
            if (item.key == currentKey) {
                foundCollision = true;
            }
        });
    }
    if (foundCollision || typeof currentKey == 'undefined') {
        $.fancybox($('.prompt-key').prop('outerHTML'), {openEffect: 'none', closeEffect: 'none'});
        
        $('.fancybox-inner').find('input[name="key"]').val(currentKey || '');
        $('.fancybox-inner').find('.' + firstMessageType).show();
        $('.fancybox-inner').find('input[name="key"]').on('keyup', function(event) {
            if (event.keyCode == 13) {
                $('.fancybox-inner').find('input[name="use"]').trigger('click');
            }
            if (event.keyCode == 27) {
                $.fancybox.close();
            }
        });
        if (!bowser.ios) {
            $('.fancybox-inner').find('input[name="key"]').select();
        }
        
        $('.fancybox-inner').find('input[name="use"]').on('click', function() {
            currentKey = $('.fancybox-inner').find('input[name="key"]').val();
            $.fancybox.close();
            
            // Use the recursive call to do the collision check with the new user input.
            promptKey(atomIdToCheckCollisions, currentKey, secondMessageType, secondMessageType, successCallback);
        });
    } else {
        successCallback(currentKey);
    }
};

// Not using this function right now.
var insertDataFromJson = function(childOf, position, dataFromJson) { // dataFromJson is a JavaScript array or object, not a JSON string
    var action = $.extend(true, {}, actionTemplate);
    action.id = generateActionId();
    action.basedOn = actionsHistoryPointer;
    insertDataFromJsonIterate(childOf, position, dataFromJson, action.steps);
    actionsHistory[action.id] = action;
};

var insertDataFromJsonIterate = function(childOf, position, data, steps) {
    var step = {
        predicate: 'create',
        atomId: generateAtomId(),
        childOf: childOf,
        position: position
    };
    steps.push(step);
    if (typeof data == 'string') {
        step.formula = 'literalString';
        step.args = [data];
    }
    if (typeof data == 'number') {
        step.formula = 'literalNumber';
        step.args = [data];
    }
    if (typeof data == 'boolean') {
        step.formula = 'literalBoolean';
        step.args = [data];
    }
    if (data === null) {
        step.formula = 'literalNull';
        step.args = [];
    }
    if ($.isArray(data)) {
        step.formula = 'list';
        step.args = [];
        $.each(data, function(i, v) {
            insertDataFromJsonIterate(step.atomId, i, v, steps);
        });
    }
    if (typeof data == 'object' && data !== null && !$.isArray(data)) {
        step.formula = 'dictionary';
        step.args = [];
        $.each(data, function(i, v) {
            insertDataFromJsonIterate(step.atomId, i, v, steps);
        });
    }
};

var insertDataFromCalculated = function(atomIdToReplace, data, description, descriptionPast) {
    var action = $.extend(true, {}, actionTemplate);
    action.id = generateActionId();
    action.basedOn = actionsHistoryPointer;
    action.description = description;
    action.descriptionPast = descriptionPast;
    insertDataFromCalculatedIterate(undefined, undefined, atomIdToReplace, data, action.steps, true);
    actionsHistory[action.id] = action;
    return action;
};

var insertDataFromCalculatedIterate = function(childOf, position, atomId, data, steps, isTopLevel) {
    var step = {};
    steps.push(step);
    if (isTopLevel) {
        step.predicate = 'change',
        step.atomId = atomId;
    } else {
        step.predicate = 'create';
        step.atomId = generateAtomId();
        step.childOf = childOf;
        step.position = position;
    }
    
    if (typeof data == 'string') {
        step.formula = 'literalString';
        step.args = [data];
    }
    if (typeof data == 'number') {
        step.formula = 'literalNumber';
        step.args = [data];
    }
    if (typeof data == 'boolean') {
        step.formula = 'literalBoolean';
        step.args = [data];
    }
    if (data === null) {
        step.formula = 'literalNull';
        step.args = [];
    }
    if (typeof data == 'object' && data !== null && !$.isArray(data)) {
        step.formula = 'literalUndefined';
        step.args = [];
    }
    if ($.isArray(data)) {
        step.formula = data.collectionType;
        step.args = [];
        if (data.collectionType == 'dictionary') {
            $.each(data, function(i, v) {
                insertDataFromCalculatedIterate(step.atomId, v.key, undefined, v.value, steps, false);
            });
        }
        if (data.collectionType == 'list') {
            $.each(data, function(i, v) {
                insertDataFromCalculatedIterate(step.atomId, i, undefined, v, steps, false);
            });
        }
        if (data.collectionType == 'set') {
            $.each(data, function(i, v) {
                step.args.push(v);
            });
        }
    }
};

// Convert real JSON (well, JavaScript object really, not a string) back into our ad-hoc data format
var importFromJson = function(json) {
    var newCollection;
    if (typeof json == 'string' || typeof json == 'number' || typeof json == 'boolean' || json === null) {
        return json;
    }
    if ($.isArray(json)) {
        newCollection = [];
        newCollection.collectionType = 'list';
        newCollection.isExpanded = true;
        newCollection.dataLink = generateAtomId();
        $.each(json, function(i, v) {
            newCollection.push(importFromJson(v));
        });
        return newCollection;
    }
    if (typeof json == 'object' && json !== null && !$.isArray(json)) {
        newCollection = [];
        newCollection.collectionType = 'dictionary';
        newCollection.isExpanded = true;
        newCollection.dataLink = generateAtomId();
        $.each(json, function(i, v) {
            newCollection.push({key: i, value: importFromJson(v)});
        });
        return newCollection;
    }
};

var deleteElement = function($element) {
    // If this element is an atom (rather than a generated element), delete the atom.
    if ($element.data('atom')) {
        var action = $.extend(true, {}, actionTemplate);
        action.id = generateActionId();
        action.basedOn = actionsHistoryPointer;
        if (formulas[atoms[$element.data('atom')].formula].isComputed) {
            action.description = 'Delete ' + atoms[$element.data('atom')].formula + ' formula';
        } else {
            action.description = 'Delete ' + formulaNames[atoms[$element.data('atom')].formula] + ' value';
        }
        action.descriptionPast = action.description.replace(/Delete/, 'deleted a');
        action.steps.push({
            predicate: 'delete',
            atomId: $element.data('atom')
        });
        actionsHistory[action.id] = action;
        processAction(actionsHistory[action.id]);
        refresh();
    } else {
        // If this element is a member of a set, remove the element from the set.
        if ($element.data('set-parent')) {
            var set = atoms[$element.data('set-parent')];
            var args = cloneArrayWithoutExcludingUndefined(set.args);
            for (var i = 0; i < args.length; i++) {
                if (args[i] === $element.data('data')[0]) {
                    args.splice(i, 1);
                    i--;
                } else {
                    if (typeof args[i] == 'object' && typeof $element.data('data')[0] == 'object' && args[i] !== null && $element.data('data')[0] !== null) { // cover case for undefined
                        args.splice(i, 1);
                        i--;
                    }
                }
            }
            
            var action = $.extend(true, {}, actionTemplate);
            action.id = generateActionId();
            action.basedOn = actionsHistoryPointer;
            action.description = 'Delete ' + getType($element.data('data')[0]) + ' value';
            action.descriptionPast = action.description.replace(/Delete/, 'deleted a');
            action.steps.push({
                predicate: 'change',
                atomId: $element.data('set-parent'),
                formula: 'set',
                args: args
            });
            actionsHistory[action.id] = action;
            processAction(actionsHistory[action.id]);
            refresh();
        }
    }
};

var clearAll = function() {
    var action = $.extend(true, {}, actionTemplate);
    action.id = generateActionId();
    action.basedOn = actionsHistoryPointer;
    action.description = 'Clear all';
    action.descriptionPast = 'cleared all';
    action.fullStateAtoms = {'0': {
        id: '0',
        formula: 'list',
        args: [],
        type: 'list',
        data: [],
        isExpanded: true,
        isDirty: false,
        // isChanged: true,
        traversedYet: false
    }};
    actionsHistory[action.id] = action;
    advanceToRevision(action.id);
    refresh();
    
    setStatusCenter('clear');
};

var tooltips = {
    'share': 'Share links',
    'share-disabled': '',
    'cookbook': 'Cookbook',
    'cookbook-disabled': '',
    'clear': 'Clear all',
    'clear-disabled': '',
    'collapse': 'Collapse all',
    'collapse-disabled': '',
    'expand': 'Expand all',
    'expand-disabled': '',
    'wrap': 'Truncate long strings',
    'wrap-disabled': '',
    'undo': 'Undo',
    'undo-disabled': 'Can\'t undo',
    'redo': 'Redo',
    'redo-disabled': 'Can\'t redo',
    'revision': 'View revision history',
    'revision-disabled': '',
    'name': 'Your name for collaboration',
    'name-disabled': ''
};

var menuMouseEnter = function($menu) {
    if (!$menu.hasClass('menu-disabled')) {
        $menu.addClass('menu-hover');
    }
    var tooltip = tooltips[$menu.data('tooltip') + ($menu.hasClass('menu-disabled') ? '-disabled' : '')];
    if (tooltip) {
        $('.tooltip').show();
        $('.tooltip').html(tooltip);
        $('.tooltip').css('top', $menu.offset().top + 36);
        $('.tooltip').css('left', $menu.offset().left + 16);
        clearTimeout(tooltipHide);
    }
};

var menuMouseLeave = function($menu) {
    $menu.removeClass('menu-hover');
    tooltipHide = setTimeout(function() {
        $('.tooltip').hide();
    }, 200);
};

var undoRedo = function(isRedo, simulateOnly) {
    var canPerform = false;
    
    if (actionsHistoryPointer == maximumActionsHistoryId) {
        var traversePointer = actionsHistoryPointer;
        var stepsIntoUndoChain = 0;
        // To find the target revision to render, traverse the unbroken chain of undo or redo actions to get us here; count up for each undo, count down for each redo
        while (actionsHistory[traversePointer].jumpType != 'normal') {
            if (actionsHistory[traversePointer].jumpType == 'undo') {
                stepsIntoUndoChain++;
            }
            if (actionsHistory[traversePointer].jumpType == 'redo') {
                stepsIntoUndoChain--;
            }
            traversePointer = actionsHistory[traversePointer].basedOn;
        }
        
        if (isRedo) {
            stepsIntoUndoChain--;
        } else {
            stepsIntoUndoChain++;
        }
        
        if (stepsIntoUndoChain >= 0) {
            // Now, go back the number of steps we have undone already (which takes into account redoes that have been performed, "undoing the undo", per above)
            while (stepsIntoUndoChain > 0 && actionsHistory.hasOwnProperty(+actionsHistory[traversePointer].basedOn)) { // Don't traverse past the beginning of the stored history
                traversePointer = actionsHistory[traversePointer].basedOn;
                stepsIntoUndoChain--;
            }
            
            if (stepsIntoUndoChain == 0) { // If we couldn't go back far enough, then do nothing
                canPerform = true;
                
                if (!simulateOnly) {
                    var action = $.extend(true, {}, actionTemplate);
                    action.id = generateActionId();
                    action.basedOn = actionsHistoryPointer;
                    action.description = (isRedo ? 'Redo' : 'Undo');
                    action.descriptionPast = (isRedo ? 'chose redo' : 'chose undo');
                    action.jumpTo = traversePointer;
                    action.jumpType = (isRedo ? 'redo' : 'undo');
                    actionsHistory[action.id] = action;
                    processAction(actionsHistory[action.id]);
                    refresh();
                }
            }
        }
    }
    
    return canPerform;
};

var undo = function() {
    undoRedo(false, false);
};

var redo = function() {
    undoRedo(true, false);
};

var pickRevision = function() {
    var revisions = [];
    $.each(actionsHistory, function(i, action) {
        revisions.push(action);
    });
    revisions.sort(function(a, b) {
        return a.id - b.id;
    });
    
    var html = '';
    $.each(revisions, function(i, action) {
        if (!isNaN(action.id)) { // security check to prevent injection from other users
            html += '<p class="revision' + (action.id == actionsHistoryPointer ? ' revision-active' : '') + '" data-revision="' + action.id + '">' + revisionDescription(action.id) + '</p>';
        }
    });
    $('.dropdown-revision').html(html);
    $('.dropdown-revision .revision').each(function() {
        $(this).on('click', function() {
            revisionPicked($(this));
        });
    });
    $('.dropdown-revision').closest('.dropdown-mask').show();
    $('.dropdown-revision').css('left', $('.menu-revision').offset().left);
    $('.dropdown-revision').scrollTop($('.dropdown-revision').scrollTop() + $('.revision-active').position().top - 20);
    
    $('.menu-revision').addClass('menu-pressed');
    
    recalculateToolbarSticky();
};

var revisionPicked = function($revision) {
    var newActionId = $revision.data('revision');
    var oldActionId = actionsHistory[newActionId].basedOn;
    
    if (actionsHistory.hasOwnProperty(oldActionId)) {
        addChangeHighlight(oldActionId, newActionId, false);
    }
    
    advanceToRevision(newActionId);
    dropdownCancel();
    refresh();
};

var dropdownCancel = function() {
    $('.dropdown-mask').hide();
    $('.menu').removeClass('menu-pressed');
};

var wrap = function() {
    wrapCollapsed = !wrapCollapsed;
    if (wrapCollapsed) {
        $('.menu-wrap').addClass('menu-wrap-collapsed');
        tooltips['wrap'] = 'Show long strings in full';
    } else {
        $('.menu-wrap').removeClass('menu-wrap-collapsed');
        tooltips['wrap'] = 'Truncate long strings';
    }
    render();
    $('.menu-wrap').trigger('mouseenter'); // Update tooltip
};

var toggleAll = function(isCollapse) {
    $('.element .button-toggle').each(function() {
        if ((isCollapse && $(this).hasClass('button-toggle-collapse')) || (!isCollapse && $(this).hasClass('button-toggle-expand'))) {
            $(this).trigger('click');
        }
    });
};

var collapseAll = function() {
    toggleAll(true);
};

var expandAll = function() {
    toggleAll(false);
};

var changeName = function() {
    var name = $('.menu-name input').val().substr(0, 15);
    if (name == 'Your name') {
        name = '';
    }
    actionTemplate.who = name;
};

var share = function() {
    if (!isPrivate) {
        $('.dropdown-share').closest('.dropdown-mask').show();
        $('.dropdown-share').css('left', $('.menu-share').offset().left);
        $('.menu-share').addClass('menu-pressed');
        
        recalculateToolbarSticky();
    }
};

var generateAtomId = function() {
    var array;
    if (window.crypto) {
        array = new Uint32Array(24);
        window.crypto.getRandomValues(array);
    } else {
        array = [];
        for (var i = 0; i < 24; i++) {
            array.push(Math.random() * 4294967296);
        }
    }
    var id = '';
    for (var i = 0; i < 24; i++) {
        id += 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.substr(Math.floor((array[i] / 4294967296) * 62), 1);
    }
    return id;
};

var generateActionId = function() {
    maximumActionsHistoryId++;
    return maximumActionsHistoryId;
};

var confirmOnPageExit = function(event) {
    var prompt = false;
    var message;
    if (isPrivate) {
        message = 'In private mode, changes are not saved. If you leave the page, your document will be lost. Are you sure you want to leave?';
    } else {
        message = 'There are changes that have not yet been saved to the server. Are you sure you want to leave the page?';
    }
    
    var revisions = [];
    var unsavedCount = 0;
    $.each(actionsHistory, function(i, action) {
        revisions.push(action);
        if (!action.isSaved) {
            unsavedCount++;
        }
    });
    if (unsavedCount > 0 && (revisions.length > 2 || (revisions.length > 1 && revisions[1].steps.length > 0))) {
        prompt = true;
    }
    
    if (prompt) {
        event.returnValue = message;
        return message;
    }
    
    return null;
};

var syncEventLoop = function() {
    setTimeout(syncEventLoop, 50);
    
    if (!inUpdateCall && !inSaveCall && !isPrivate) {
        var revisions = [];
        var unsavedCount = 0;
        $.each(actionsHistory, function(i, action) {
            revisions.push(action);
            if (!action.isSaved) {
                unsavedCount++;
            }
        });
        if (unsavedCount > 0) {
            if (unsavedCount > 1) {
                revisions.sort(function(a, b) {
                    return a.id - b.id;
                });
            }
            
            var toSave = undefined;
            $.each(revisions, function(i, action) {
                if (!action.isSaved && !action.isRejected && toSave === undefined) {
                    toSave = action;
                }
            });
            if (toSave !== undefined) {
                // If we have a new document, only saved if we've made an edit besides clearing all; or if it's read-only or we're cloning it and we need to fork it
                if (isReadOnly || window.location.pathname.indexOf('/clone') != -1 || documentId || revisions.length > 2 || (revisions.length > 1 && revisions[1].steps.length > 0)) {
                    if (isReadOnly) {
                        documentId = '';
                        isReadOnly = false;
                        readOnlyDocumentId = '';
                        history.replaceState({}, '', window.location.protocol + '//' + window.location.host + '/');
                        
                        setStatusCenter('forked');
                        
                        var action = $.extend(true, {}, actionTemplate);
                        action.fullStateAtoms = $.extend(true, {}, atoms);
                        action.description = 'Clone document';
                        action.descriptionPast = 'cloned the document';
                        actionsHistory = {'0': action};
                        actionsHistoryPointer = 0;
                        maximumActionsHistoryId = 0;
                        
                        saveAction(0);
                    } else {
                        saveAction(toSave.id);
                    }
                }
            }
        }
    }
    
    if (!inUpdateCall && !inSaveCall && !isPrivate && documentId) {
        var timeSinceUpdate = new Date().getTime() - lastTimeUpdated;
        var timeSinceResetUpdateInterval = new Date().getTime() - lastTimeResetUpdateInterval;
        var intervalLength;
        // Start interval at 250ms; scale up linearly to 1.0s over 1 minute; then scale up exponentially from 1s to 120s over 60 minutes (total elapsed 1 hour 1 minute)
        if (timeSinceResetUpdateInterval < 60000) {
            intervalLength = 250 + 750 * (timeSinceResetUpdateInterval / 60000);
        }
        if (timeSinceResetUpdateInterval >= 60000 && timeSinceResetUpdateInterval < 3660000) {
            intervalLength = 923 * Math.pow(1.083, timeSinceResetUpdateInterval / 60000);
        }
        if (timeSinceResetUpdateInterval >= 3660000) {
            intervalLength = 120000;
        }
        
        if (timeSinceUpdate > intervalLength) {
            if (uiState == 'normal' && $('.fancybox-overlay').length == 0) {
                checkForUpdates();
            }
        }
    }
    
    actionTemplate.when = new Date().getTime();
};

var saveAction = function(actionId) {
    inSaveCall = true;
    
    var actionWithoutAtoms = $.extend(true, {}, actionsHistory[actionId]);
    if (actionWithoutAtoms.steps.length > 0 && actionWithoutAtoms.jumpTo == null && actionWithoutAtoms.id != 0) {
        actionWithoutAtoms.fullStateAtoms = null;
    }
    
    $.ajax({type: 'POST', timeout: 5000, url: '/main.py?' + new Date().getTime(),
        data: JSON.stringify({version: 1, 'function': 'save', id: documentId, action: actionWithoutAtoms}),
        success: function(resp) {
            if (resp.message == 'version') {
                oldVersion();
            }
            if (resp.message == 'needFullAtoms') {
                var actionWithAtoms = actionsHistory[actionId];
                if (actionWithAtoms.fullStateAtoms === null) {
                    var state = saveState();
                    advanceToRevision(actionId);
                    actionWithAtoms.fullStateAtoms = $.extend(true, {}, atoms);
                    $.each(actionWithAtoms.fullStateAtoms, function(i, atom) {
                        atom.data = null;
                        atom.type = null;
                    });
                    loadState(state);
                }
                
                $.ajax({type: 'POST', timeout: 5000, url: '/main.py?' + new Date().getTime(),
                    data: JSON.stringify({version: 1, 'function': 'save', id: documentId, action: actionWithAtoms}),
                    success: function(resp) {
                        if (resp.message == 'version') {
                            oldVersion();
                        }
                        if (resp.message == 'rejected') {
                            markUnsavedRejected();
                            inSaveCall = false;
                        }
                        if (resp.message == 'tooBig') {
                            tooBig();
                            inSaveCall = false;
                        }
                        if (resp.message == 'success') {
                            actionsHistory[actionId].isSaved = true;
                            actionsHistory[actionId].when = resp.when;
                            updateDocumentId(documentId, resp.id, false, resp.readOnlyId);
                            inSaveCall = false;
                        }
                    },
                    error: function(resp) {
                        inSaveCall = false;
                    }
                });
            }
            if (resp.message == 'rejected') {
                markUnsavedRejected();
                inSaveCall = false;
            }
            if (resp.message == 'success') {
                actionsHistory[actionId].isSaved = true;
                actionsHistory[actionId].when = resp.when;
                updateDocumentId(documentId, resp.id, false, resp.readOnlyId);
                inSaveCall = false;
            }
            if (resp.message == 'tooBig') {
                tooBig();
                inSaveCall = false;
            }
            if (resp.message == 'error') {
                inSaveCall = false;
            }
        },
        error: function(resp) {
            inSaveCall = false;
        }
    });
};

var markUnsavedRejected = function() {
    $.each(actionsHistory, function(i, action) {
        if (!action.isSaved) {
            action.isRejected = true;
        }
    });
};

var tooBig = function() {
    var maxNonRejectedAction = -1;
    var toDelete = [];
    $.each(actionsHistory, function(i, action) {
        if (!action.isSaved) {
            toDelete.push(action.id);
        } else {
            maxNonRejectedAction = Math.max(maxNonRejectedAction, action.id);
        }
    });
    $.each(toDelete, function(i, toDeleteItem) {
        delete actionsHistory[toDeleteItem];
    });
    advanceToRevision(maxNonRejectedAction);
    refresh();
    setStatusCenter('toobig');
};

var updateDocumentId = function(currentDocumentId, newDocumentId, isReadOnlyArg, newReadOnlyDocumentId) {
    if (!currentDocumentId) {
        documentId = newDocumentId;
        isReadOnly = isReadOnlyArg;
        
        $('.dropdown-share .link-notice').hide();
        $('.dropdown-share .link-view').show();
        $('.dropdown-share .link-clone').show();
        $('.dropdown-share .link-clone a').attr('href', window.location.protocol + '//' + window.location.host + '/docs/' + newDocumentId + '/clone');
        if (isReadOnlyArg) {
            $('.dropdown-share .link-view a').attr('href', window.location.protocol + '//' + window.location.host + '/docs/' + newDocumentId);
            $('.header-notice').show();
            $('.header-notice').html($('.header-notice-text-read-only').html());
        } else {
            readOnlyDocumentId = newReadOnlyDocumentId;
            $('.dropdown-share .link-edit').show();
            $('.dropdown-share .link-edit a').attr('href', window.location.protocol + '//' + window.location.host + '/docs/' + newDocumentId);
            $('.dropdown-share .link-view a').attr('href', window.location.protocol + '//' + window.location.host + '/docs/' + newReadOnlyDocumentId);
            $('.header-notice').hide();
        }
        recalculateToolbarSticky();
        
        if (window.location.pathname.indexOf('/clone') != -1) {
            setStatusCenter('cloned');
        }
        history.replaceState({}, '', window.location.protocol + '//' + window.location.host + '/docs/' + newDocumentId);
    }
};

var checkForUpdates = function() {
    inUpdateCall = true;
    
    $.ajax({type: 'GET', timeout: 5000, url: '/data/' + documentId.substr(0, 2) + '/' + documentId.substr(2, 2) + '/' + documentId.substr(4, 28) + '/latest.json?' + new Date().getTime(),
        success: function(resp) {
            inUpdateCall = false;
            if (isJson(resp)) {
                var respParse = JSON.parse(resp);
                if (respParse === 'version') {
                    oldVersion();
                } else {
                    var lastSavedActionId = -1;
                    $.each(actionsHistory, function(i, action) {
                        if (action.isSaved) {
                            lastSavedActionId = Math.max(lastSavedActionId, action.id);
                        }
                    });
                    if (typeof respParse == 'number' && respParse > lastSavedActionId) {
                        inUpdateCall = true;
                        
                        $.ajax({type: 'POST', timeout: 5000, url: '/main.py?' + new Date().getTime(),
                            data: JSON.stringify({version: 1, 'function': 'update', id: documentId, latest: lastSavedActionId}),
                            success: function(resp) {
                                if (resp.message == 'version') {
                                    oldVersion();
                                }
                                if (resp.message == 'success') {
                                    if (uiState == 'normal' && $('.fancybox-overlay').length == 0) {
                                        var oldActionsHistoryPointer = actionsHistoryPointer;
                                        var isUnsavedAction = false;
                                        $.each(actionsHistory, function(i, action) {
                                            if (!action.isSaved) {
                                                isUnsavedAction = true;
                                            }
                                        });
                                        if (!isUnsavedAction) {
                                            // "Ordinary" case where the remote actions don't conflict with any unsaved local ones.
                                            $.each(resp.actions, function(i, action) {
                                                actionsHistory[action.id] = action;
                                                action.isSaved = true;
                                                action.isRejected = false;
                                                action.traversedYet = false;
                                                maximumActionsHistoryId = Math.max(maximumActionsHistoryId, action.id);
                                                displayUserNotice(action);
                                            });
                                            advanceToRevision(maximumActionsHistoryId);
                                            addChangeHighlight(oldActionsHistoryPointer, maximumActionsHistoryId, true);
                                            refresh();
                                        } else {
                                            // If local actions exist that haven't been saved yet, then there is a potential conflict.
                                            // When this happens, we need to accept the server actions as the server is the single source of truth.
                                            // However, let's test to see if we need to reject the local actions - or if, instead, it's safe to silently merge them.
                                            
                                            // We run a test by playing back the local actions prior to the remote actions, and saving a snapshot of the computed data.
                                            // Then, we play back the remote actions prior to the local actions, and save that snapshot.
                                            // If that snapshot matches, we accept the changes. Otherwise, reject the local actions.
                                            
                                            var state = saveState();
                                            
                                            // This part tests the local actions prior to the remote actions.
                                            
                                            var errorFound = false;
                                            var dataSignatureLocalFirst;
                                            var dataSignatureRemoteFirst;
                                            
                                            var latestSavedActionId = -1;
                                            $.each(actionsHistory, function(j, actionLocal) {
                                                if (actionLocal.isSaved) {
                                                    latestSavedActionId = Math.max(latestSavedActionId, actionLocal.id);
                                                }
                                            });
                                            var latestActionId = -1;
                                            $.each(resp.actions, function(i, action) {
                                                // Adjust the IDs of the remote actions so they are always after the local actions.
                                                var actionClone = $.extend(true, {}, action);
                                                actionClone.id += 1000000000;
                                                actionClone.isSaved = true;
                                                actionClone.isRejected = false;
                                                actionClone.traversedYet = false;
                                                var foundLocal = false;
                                                $.each(actionsHistory, function(j, actionLocal) {
                                                    if (actionClone.basedOn == actionLocal.id) {
                                                        foundLocal = true;
                                                    }
                                                });
                                                if (actionClone.basedOn == latestSavedActionId) {
                                                    // Link the server's actions to the end of our chain of local actions which include additional, non-official ones the server doesn't know about
                                                    actionClone.basedOn = maximumActionsHistoryId;
                                                } else {
                                                    if (!actionsHistory.hasOwnProperty(actionClone.basedOn) || !actionsHistory[actionClone.basedOn].isSaved) {
                                                        actionClone.basedOn += 1000000000;
                                                    }
                                                    if (actionClone.jumpTo !== null && (!actionsHistory.hasOwnProperty(actionClone.jumpTo) || !actionsHistory[actionClone.jumpTo].isSaved)) {
                                                        actionClone.jumpTo += 1000000000;
                                                    }
                                                }
                                                actionsHistory[actionClone.id] = actionClone;
                                                latestActionId = Math.max(latestActionId, actionClone.id);
                                            });
                                            try {
                                                advanceToRevision(latestActionId);
                                                recalculate();
                                                dataSignatureLocalFirst = dataSignature(atoms['0'].data);
                                            } catch(e) {
                                                errorFound = true;
                                            }
                                            
                                            loadState(state);
                                            
                                            // This part tests the remote actions prior to the local actions.
                                            
                                            // Find the largest ID of the remote actions and compare it to the largest ID of the local, already-saved actions.
                                            var latestRemoteActionId = -1;
                                            $.each(resp.actions, function(i, action) {
                                                latestRemoteActionId = Math.max(latestRemoteActionId, action.id);
                                            });
                                            latestActionId = -1;
                                            var toChangeKeys = [];
                                            $.each(actionsHistory, function(i, action) {
                                                // For all the unsaved local actions, "push forward" past the remote actions.
                                                if (!action.isSaved) {
                                                    action.id += (latestRemoteActionId - lastSavedActionId);
                                                    if (!actionsHistory.hasOwnProperty(action.basedOn) || !actionsHistory[action.basedOn].isSaved) {
                                                        action.basedOn += (latestRemoteActionId - lastSavedActionId);
                                                    }
                                                    if (action.jumpTo !== null && (!actionsHistory.hasOwnProperty(action.jumpTo) || !actionsHistory[action.jumpTo].isSaved)) {
                                                        action.jumpTo += (latestRemoteActionId - lastSavedActionId);
                                                    }
                                                    latestActionId = Math.max(latestActionId, action.id);
                                                    toChangeKeys.push(action);
                                                }
                                            });
                                            // To complete the "push forward" above, adjust the keys in the actionsHistory object to match the id properties in each element
                                            if (latestRemoteActionId - lastSavedActionId > 0) {
                                                $.each(toChangeKeys, function(i, action) {
                                                    delete actionsHistory[action.id - (latestRemoteActionId - lastSavedActionId)];
                                                });
                                                $.each(toChangeKeys, function(i, action) {
                                                    actionsHistory[action.id] = action;
                                                });
                                            }
                                            // Insert the remote actions locally.
                                            $.each(resp.actions, function(i, action) {
                                                var actionClone = $.extend(true, {}, action);
                                                actionClone.isSaved = true;
                                                actionClone.isRejected = false;
                                                actionClone.traversedYet = false;
                                                actionsHistory[actionClone.id] = actionClone;
                                            });
                                            // Link the first remote action to the last local action.
                                            $.each(actionsHistory, function(i, action) {
                                                if (!action.isSaved) {
                                                    if (action.basedOn == lastSavedActionId) {
                                                        action.basedOn = latestRemoteActionId;
                                                    }
                                                }
                                            });
                                            try {
                                                advanceToRevision(latestActionId);
                                                recalculate();
                                                dataSignatureRemoteFirst = dataSignature(atoms['0'].data);
                                            } catch(e) {
                                                errorFound = true;
                                            }
                                            
                                            if (!errorFound) {
                                                if (JSON.stringify(dataSignatureLocalFirst) != JSON.stringify(dataSignatureRemoteFirst)) {
                                                    errorFound = true;
                                                }
                                            }
                                            
                                            if (errorFound) {
                                                loadState(state);
                                                
                                                maximumActionsHistoryId = -1;
                                                $.each(actionsHistory, function(i, action) {
                                                    if (!action.isSaved) {
                                                        delete actionsHistory[i];
                                                    } else {
                                                        maximumActionsHistoryId = Math.max(maximumActionsHistoryId, action.id);
                                                    }
                                                });
                                                $.each(resp.actions, function(i, action) {
                                                    actionsHistory[action.id] = action;
                                                    action.isSaved = true;
                                                    action.isRejected = false;
                                                    action.traversedYet = false;
                                                    maximumActionsHistoryId = Math.max(maximumActionsHistoryId, action.id);
                                                });
                                                advanceToRevision(maximumActionsHistoryId);
                                                refresh();
                                                
                                                setStatusCenter('conflict');
                                            } else {
                                                $.each(resp.actions, function(i, action) {
                                                    displayUserNotice(action);
                                                });
                                                $.each(actionsHistory, function(i, action) {
                                                    action.isRejected = false;
                                                });
                                                addChangeHighlight(oldActionsHistoryPointer, latestActionId, true);
                                                refresh();
                                            }
                                        }
                                        
                                        lastTimeUpdated = new Date().getTime();
                                        lastTimeResetUpdateInterval = new Date().getTime();
                                    }
                                }
                                
                                inUpdateCall = false;
                            },
                            error: function(resp) {
                                inUpdateCall = false;
                            }
                        });
                    } else {
                        lastTimeUpdated = new Date().getTime();
                    }
                }
            }
        },
        error: function(resp) {
            inUpdateCall = false;
        }
    });
};

// Notices from real-time remote user actions
var displayUserNotice = function(action) {
    var $element = $('<div class="status-notice"></div>');
    $('body').append($element);
    if (action.who) {
        $element.text(action.who + ' ' + action.descriptionPast);
    } else {
        $element.text('Another user ' + action.descriptionPast);
    }
    
    // If there are 8 notices already, kill the oldest
    
    var numNotices = userNotices.length;
    if (numNotices == 8) {
        $element.css('bottom', 20);
    } else {
        $element.css('bottom', 20 + 34 * numNotices);
    }
    
    if (numNotices == 8) {
        userNotices[0].element.remove();
        userNotices[0] = {element: $element, when: new Date().getTime()};
    } else {
        userNotices.push({element: $element, when: new Date().getTime()});
    }
};

var loadInitialData = function() {
    inUpdateCall = true;
    
    setStatusCenter('loading');
    $('.loading-mask').show();
    
    var error = function(message, onClose) {
        $.fancybox(message, {openEffect: 'none', closeEffect: 'none'});
        
        var redirect = function() {
            if ($('.fancybox-overlay').length == 0) {
                onClose();
            } else {
                setTimeout(redirect, 50);
            }
        };
        redirect();
    };
    
    $.ajax({type: 'POST', timeout: 10000, url: '/main.py?' + new Date().getTime(),
        data: JSON.stringify({version: 1, 'function': 'update', id: documentId, latest: -1}),
        success: function(resp) {
            statusCenterDisplay = 0;
            $('.loading-mask').hide();
            
            if (resp.message == 'success') {
                $.each(resp.actions, function(i, action) {
                    actionsHistory[action.id] = action;
                    action.isSaved = true;
                    action.isRejected = false;
                    action.traversedYet = false;
                    maximumActionsHistoryId = Math.max(maximumActionsHistoryId, action.id);
                });
                advanceToRevision(maximumActionsHistoryId);
                refresh();
                
                if (window.location.pathname.indexOf('/clone') != -1) {
                    var action = $.extend(true, {}, actionTemplate);
                    action.fullStateAtoms = $.extend(true, {}, atoms);
                    action.description = 'Clone document';
                    action.descriptionPast = 'cloned the document';
                    actionsHistory = {'0': action};
                    actionsHistoryPointer = 0;
                    maximumActionsHistoryId = 0;
                    documentId = '';
                    isReadOnly = false;
                    readOnlyDocumentId = '';
                } else {
                    updateDocumentId('', documentId, resp.isReadOnly, resp.readOnlyId);
                }
                
                inUpdateCall = false;
            }
            if (resp.message == 'error') {
                error('We\'re sorry. The document was not found. Documents are normally deleted after 15 days of inaccess.', function() {
                    window.location.replace('/');
                });
            }
        },
        error: function(resp) {
            error('We\'re sorry. A server error occurred.', function() {
                document.location.reload(true);
            });
        }
    });
};

var saveState = function() {
    return {
        atoms: $.extend(true, {}, atoms),
        actionsHistory: $.extend(true, {}, actionsHistory),
        actionsHistoryPointer: actionsHistoryPointer,
        maximumActionsHistoryId: maximumActionsHistoryId,
        uiState: uiState,
        dataLinkIndex: $.extend(true, {}, dataLinkIndex),
        lastTimeResetUpdateInterval: lastTimeResetUpdateInterval,
        lastTimeUpdated: lastTimeUpdated,
    };
};

var loadState = function(state) {
    atoms = $.extend(true, {}, state.atoms);
    actionsHistory = $.extend(true, {}, state.actionsHistory);
    actionsHistoryPointer = state.actionsHistoryPointer;
    maximumActionsHistoryId = state.maximumActionsHistoryId;
    uiState = state.uiState;
    dataLinkIndex = $.extend(true, {}, state.dataLinkIndex);
    lastTimeResetUpdateInterval = lastTimeResetUpdateInterval;
    lastTimeUpdated = lastTimeUpdated;
};

var oldVersion = function() {
    isPrivate = true;
    document.location.reload(true);
};

var cookbook = function() {
    $('.dropdown-cookbook').closest('.dropdown-mask').show();
    $('.dropdown-cookbook').css('left', $('.menu-cookbook').offset().left);
    $('.menu-cookbook').addClass('menu-pressed');
    
    recalculateToolbarSticky();
};

var cookbookRecipe = function(token, actionProvided) {
    var action;
    if (typeof actionProvided == 'undefined') {
        action = $.extend(true, {}, actionTemplate);
        action.id = generateActionId();
        action.basedOn = actionsHistoryPointer;
        action.description = 'Add cookbook recipe ' + token;
        action.descriptionPast = 'added cookbook recipe ' + token;
    } else {
        action = actionProvided;
    }
    
    var atomIds = [];
    var generateMultipleAtomIds = function(n) {
        for (var i = 0; i < n; i++) {
            atomIds.push(generateAtomId());
        }
    };
    
    var importAtoms;
    switch (token) {
        case 'initialize':
            generateMultipleAtomIds(54);
            importAtoms = [{"id":"sentinel-0","formula":"dictionary","args":[{"key":" about","value":"sentinel-1"},{"key":" data types","value":"sentinel-2"},{"key":"collection types","value":"sentinel-3"}],"isExpanded":true},{"id":"sentinel-4","formula":"list","args":["sentinel-5","sentinel-6","sentinel-7","sentinel-8","sentinel-9","sentinel-10","sentinel-11"],"isExpanded":true},{"id":"sentinel-5","formula":"literalNumber","args":[1],"isExpanded":true},{"id":"sentinel-6","formula":"literalNumber","args":[2],"isExpanded":true},{"id":"sentinel-8","formula":"literalNumber","args":[51],"isExpanded":true},{"id":"sentinel-10","formula":"literalNumber","args":[49],"isExpanded":true},{"id":"sentinel-9","formula":"literalNumber","args":[50],"isExpanded":true},{"id":"sentinel-11","formula":"literalNumber","args":[100],"isExpanded":true},{"id":"sentinel-12","formula":"dictionary","args":[{"key":"abc","value":"sentinel-13"},{"key":"hello","value":"sentinel-14"}],"isExpanded":true},{"id":"sentinel-14","formula":"literalString","args":["world"],"isExpanded":true},{"id":"sentinel-13","formula":"literalString","args":["xyz"],"isExpanded":true},{"id":"sentinel-15","formula":"set","args":["apple","lemon","orange"],"isExpanded":true},{"id":"sentinel-2","formula":"dictionary","args":[{"key":"boolean","value":"sentinel-16"},{"key":"null","value":"sentinel-17"},{"key":"number","value":"sentinel-18"},{"key":"string","value":"sentinel-19"},{"key":"undefined","value":"sentinel-20"}],"isExpanded":true},{"id":"sentinel-18","formula":"literalNumber","args":[5],"isExpanded":true},{"id":"sentinel-16","formula":"literalBoolean","args":[true],"isExpanded":true},{"id":"sentinel-17","formula":"literalNull","args":[],"isExpanded":true},{"id":"sentinel-20","formula":"literalUndefined","args":[],"isExpanded":true},{"id":"sentinel-19","formula":"literalString","args":["abcde"],"isExpanded":true},{"id":"sentinel-3","formula":"dictionary","args":[{"key":"dictionary","value":"sentinel-12"},{"key":"list","value":"sentinel-4"},{"key":"set","value":"sentinel-15"}],"isExpanded":true},{"id":"sentinel-21","formula":"dictionary","args":[{"key":"example data sets","value":"sentinel-22"},{"key":"formulas","value":"sentinel-23"}],"isExpanded":true},{"id":"sentinel-23","formula":"dictionary","args":[{"key":"concatenate","value":"sentinel-24"},{"key":"intersection","value":"sentinel-25"},{"key":"product","value":"sentinel-26"},{"key":"regex","value":"sentinel-27"},{"key":"reverse list","value":"sentinel-28"},{"key":"reverse strings","value":"sentinel-29"},{"key":"split","value":"sentinel-30"},{"key":"sum of collection","value":"sentinel-31"},{"key":"sum of collection and number","value":"sentinel-32"},{"key":"sum of two collections","value":"sentinel-33"},{"key":"union","value":"sentinel-34"},{"key":"unique","value":"sentinel-35"}],"isExpanded":true},{"id":"sentinel-35","formula":"unique","args":["sentinel-4"],"isExpanded":false},{"id":"sentinel-24","formula":"concatenate","args":["sentinel-15"],"isExpanded":true},{"id":"sentinel-29","formula":"reverseStrings","args":["sentinel-15"],"isExpanded":false},{"id":"sentinel-28","formula":"reverse","args":["sentinel-4"],"isExpanded":false},{"id":"sentinel-31","formula":"sum","args":["sentinel-4"],"isExpanded":true},{"id":"sentinel-32","formula":"sum","args":["sentinel-4","sentinel-18"],"isExpanded":false},{"id":"sentinel-26","formula":"product","args":["sentinel-4","sentinel-18"],"isExpanded":false},{"id":"sentinel-34","formula":"union","args":["sentinel-4","sentinel-15"],"isExpanded":false},{"id":"sentinel-22","formula":"dictionary","args":[{"key":"email addresses","value":"sentinel-36"},{"key":"even numbers to 100","value":"sentinel-37"},{"key":"integers to 50","value":"sentinel-38"},{"key":"very","value":"sentinel-39"}],"isExpanded":true},{"id":"sentinel-7","formula":"literalNumber","args":[2],"isExpanded":true},{"id":"sentinel-38","formula":"generate","args":["sentinel-5","sentinel-9","@"],"isExpanded":false},{"id":"sentinel-37","formula":"generate","args":["sentinel-5","sentinel-9","@ * 2"],"isExpanded":false},{"id":"sentinel-36","formula":"list","args":["sentinel-40","sentinel-41","sentinel-42","sentinel-43","sentinel-44"],"isExpanded":false},{"id":"sentinel-40","formula":"literalString","args":["amy@example.com"],"isExpanded":true},{"id":"sentinel-41","formula":"literalString","args":["beth@example.com"],"isExpanded":true},{"id":"sentinel-42","formula":"literalString","args":["cathy@example.com"],"isExpanded":true},{"id":"sentinel-43","formula":"literalString","args":["dan@example.com"],"isExpanded":true},{"id":"sentinel-44","formula":"literalString","args":["eric@example.com"],"isExpanded":true},{"id":"sentinel-27","formula":"regex","args":["sentinel-36","@","g","-at-sign-"],"isExpanded":false},{"id":"sentinel-1","formula":"list","args":["sentinel-45","sentinel-46","sentinel-47","sentinel-48","sentinel-49"],"isExpanded":true},{"id":"sentinel-46","formula":"literalString","args":["To collaborate in real time with others, click the paperclip to view share links."],"isExpanded":true},{"id":"sentinel-47","formula":"literalString","args":["Click the cookbook for more examples."],"isExpanded":true},{"id":"sentinel-45","formula":"literalString","args":["If you're on a small screen, click the side arrows to see additional columns."],"isExpanded":true},{"id":"sentinel-49","formula":"literalString","args":["Happy editing!"],"isExpanded":true},{"id":"sentinel-48","formula":"literalString","args":["Click clear all to start with a fresh blank document."],"isExpanded":true},{"id":"sentinel-39","formula":"dictionary","args":[{"key":"deeply","value":"sentinel-50"}],"isExpanded":true},{"id":"sentinel-50","formula":"dictionary","args":[{"key":"nested","value":"sentinel-51"}],"isExpanded":true},{"id":"sentinel-51","formula":"dictionary","args":[{"key":"data","value":"sentinel-52"}],"isExpanded":false},{"id":"sentinel-52","formula":"dictionary","args":[{"key":"set","value":"sentinel-53"}],"isExpanded":false},{"id":"sentinel-53","formula":"list","args":[],"isExpanded":false},{"id":"sentinel-30","formula":"split","args":["sentinel-46"," "],"isExpanded":false},{"id":"sentinel-25","formula":"intersection","args":["sentinel-38","sentinel-37"],"isExpanded":false},{"id":"sentinel-33","formula":"sum","args":["sentinel-37","sentinel-38"],"isExpanded":false}];
            columnAtoms = ["sentinel-0", "sentinel-21"];
            break;
        case 'shopping list':
            generateMultipleAtomIds(77);
            importAtoms = [{"id":"sentinel-0","formula":"list","args":["sentinel-1","sentinel-2","sentinel-3","sentinel-4","sentinel-5","sentinel-6","sentinel-7","sentinel-8"],"isExpanded":true},{"id":"sentinel-9","formula":"dictionary","args":[{"key":"convenience store","value":"sentinel-10"},{"key":"quantities","value":"sentinel-11"},{"key":"quantity costs","value":"sentinel-12"},{"key":"to buy all stores","value":"sentinel-13"},{"key":"total cost","value":"sentinel-14"},{"key":"unit costs","value":"sentinel-15"}],"isExpanded":true},{"id":"sentinel-13","formula":"jsonPath","args":["sentinel-0","$[?(@.buy)].name"],"isExpanded":true},{"id":"sentinel-1","formula":"dictionary","args":[{"key":"buy","value":"sentinel-16"},{"key":"name","value":"sentinel-17"},{"key":"price","value":"sentinel-18"},{"key":"quantity","value":"sentinel-19"},{"key":"stores","value":"sentinel-20"}],"isExpanded":true},{"id":"sentinel-17","formula":"literalString","args":["milk"],"isExpanded":true},{"id":"sentinel-16","formula":"literalBoolean","args":[true],"isExpanded":true},{"id":"sentinel-18","formula":"literalNumber","args":[2.99],"isExpanded":true},{"id":"sentinel-19","formula":"literalNumber","args":[1],"isExpanded":true},{"id":"sentinel-20","formula":"list","args":["sentinel-21","sentinel-22"],"isExpanded":true},{"id":"sentinel-21","formula":"literalString","args":["grocery"],"isExpanded":true},{"id":"sentinel-22","formula":"literalString","args":["convenience"],"isExpanded":true},{"id":"sentinel-2","formula":"dictionary","args":[{"key":"buy","value":"sentinel-23"},{"key":"name","value":"sentinel-24"},{"key":"price","value":"sentinel-25"},{"key":"quantity","value":"sentinel-26"},{"key":"stores","value":"sentinel-27"}],"isExpanded":true},{"id":"sentinel-24","formula":"literalString","args":["light bulbs"],"isExpanded":true},{"id":"sentinel-23","formula":"literalBoolean","args":[true],"isExpanded":true},{"id":"sentinel-25","formula":"literalNumber","args":[6.99],"isExpanded":true},{"id":"sentinel-26","formula":"literalNumber","args":[1],"isExpanded":true},{"id":"sentinel-27","formula":"list","args":["sentinel-28","sentinel-29"],"isExpanded":true},{"id":"sentinel-28","formula":"literalString","args":["grocery"],"isExpanded":true},{"id":"sentinel-29","formula":"literalString","args":["home"],"isExpanded":true},{"id":"sentinel-3","formula":"dictionary","args":[{"key":"buy","value":"sentinel-30"},{"key":"name","value":"sentinel-31"},{"key":"price","value":"sentinel-32"},{"key":"quantity","value":"sentinel-33"},{"key":"stores","value":"sentinel-34"}],"isExpanded":true},{"id":"sentinel-31","formula":"literalString","args":["eggs"],"isExpanded":true},{"id":"sentinel-30","formula":"literalBoolean","args":[true],"isExpanded":true},{"id":"sentinel-32","formula":"literalNumber","args":[2.99],"isExpanded":true},{"id":"sentinel-33","formula":"literalNumber","args":[1],"isExpanded":true},{"id":"sentinel-34","formula":"list","args":["sentinel-35","sentinel-36"],"isExpanded":true},{"id":"sentinel-35","formula":"literalString","args":["grocery"],"isExpanded":true},{"id":"sentinel-36","formula":"literalString","args":["convenience"],"isExpanded":true},{"id":"sentinel-4","formula":"dictionary","args":[{"key":"buy","value":"sentinel-37"},{"key":"name","value":"sentinel-38"},{"key":"price","value":"sentinel-39"},{"key":"quantity","value":"sentinel-40"},{"key":"stores","value":"sentinel-41"}],"isExpanded":true},{"id":"sentinel-38","formula":"literalString","args":["bread"],"isExpanded":true},{"id":"sentinel-37","formula":"literalBoolean","args":[true],"isExpanded":true},{"id":"sentinel-39","formula":"literalNumber","args":[2.49],"isExpanded":true},{"id":"sentinel-40","formula":"literalNumber","args":[1],"isExpanded":true},{"id":"sentinel-41","formula":"list","args":["sentinel-42"],"isExpanded":true},{"id":"sentinel-42","formula":"literalString","args":["grocery"],"isExpanded":true},{"id":"sentinel-5","formula":"dictionary","args":[{"key":"buy","value":"sentinel-43"},{"key":"name","value":"sentinel-44"},{"key":"price","value":"sentinel-45"},{"key":"quantity","value":"sentinel-46"},{"key":"stores","value":"sentinel-47"}],"isExpanded":true},{"id":"sentinel-44","formula":"literalString","args":["shirts"],"isExpanded":true},{"id":"sentinel-43","formula":"literalBoolean","args":[true],"isExpanded":true},{"id":"sentinel-45","formula":"literalNumber","args":[14.99],"isExpanded":true},{"id":"sentinel-46","formula":"literalNumber","args":[2],"isExpanded":true},{"id":"sentinel-47","formula":"list","args":["sentinel-48"],"isExpanded":true},{"id":"sentinel-48","formula":"literalString","args":["clothing"],"isExpanded":true},{"id":"sentinel-6","formula":"dictionary","args":[{"key":"buy","value":"sentinel-49"},{"key":"name","value":"sentinel-50"},{"key":"price","value":"sentinel-51"},{"key":"quantity","value":"sentinel-52"},{"key":"stores","value":"sentinel-53"}],"isExpanded":true},{"id":"sentinel-50","formula":"literalString","args":["pizza"],"isExpanded":true},{"id":"sentinel-49","formula":"literalBoolean","args":[false],"isExpanded":true},{"id":"sentinel-51","formula":"literalNumber","args":[4.29],"isExpanded":true},{"id":"sentinel-52","formula":"literalNumber","args":[1],"isExpanded":true},{"id":"sentinel-53","formula":"list","args":["sentinel-54","sentinel-55"],"isExpanded":true},{"id":"sentinel-54","formula":"literalString","args":["grocery"],"isExpanded":true},{"id":"sentinel-55","formula":"literalString","args":["convenience"],"isExpanded":true},{"id":"sentinel-7","formula":"dictionary","args":[{"key":"buy","value":"sentinel-56"},{"key":"name","value":"sentinel-57"},{"key":"price","value":"sentinel-58"},{"key":"quantity","value":"sentinel-59"},{"key":"stores","value":"sentinel-60"}],"isExpanded":true},{"id":"sentinel-57","formula":"literalString","args":["paper towels"],"isExpanded":true},{"id":"sentinel-56","formula":"literalBoolean","args":[true],"isExpanded":true},{"id":"sentinel-58","formula":"literalNumber","args":[4.29],"isExpanded":true},{"id":"sentinel-59","formula":"literalNumber","args":[1],"isExpanded":true},{"id":"sentinel-60","formula":"list","args":["sentinel-61","sentinel-62","sentinel-63"],"isExpanded":true},{"id":"sentinel-61","formula":"literalString","args":["grocery"],"isExpanded":true},{"id":"sentinel-62","formula":"literalString","args":["home"],"isExpanded":true},{"id":"sentinel-63","formula":"literalString","args":["drugstore"],"isExpanded":true},{"id":"sentinel-8","formula":"dictionary","args":[{"key":"buy","value":"sentinel-64"},{"key":"name","value":"sentinel-65"},{"key":"price","value":"sentinel-66"},{"key":"quantity","value":"sentinel-67"},{"key":"stores","value":"sentinel-68"}],"isExpanded":true},{"id":"sentinel-65","formula":"literalString","args":["trash bags"],"isExpanded":true},{"id":"sentinel-64","formula":"literalBoolean","args":[true],"isExpanded":true},{"id":"sentinel-66","formula":"literalNumber","args":[4.29],"isExpanded":true},{"id":"sentinel-67","formula":"literalNumber","args":[1],"isExpanded":true},{"id":"sentinel-68","formula":"list","args":["sentinel-69","sentinel-70","sentinel-71"],"isExpanded":true},{"id":"sentinel-69","formula":"literalString","args":["grocery"],"isExpanded":true},{"id":"sentinel-70","formula":"literalString","args":["home"],"isExpanded":true},{"id":"sentinel-71","formula":"literalString","args":["drugstore"],"isExpanded":true},{"id":"sentinel-10","formula":"jsonPath","args":["sentinel-0","$[?(@.stores.indexOf('convenience') != -1 && @.buy)].name"],"isExpanded":false},{"id":"sentinel-15","formula":"jsonPath","args":["sentinel-0","$[?(@.buy)].price"],"isExpanded":false},{"id":"sentinel-14","formula":"sum","args":["sentinel-12"],"isExpanded":true},{"id":"sentinel-11","formula":"jsonPath","args":["sentinel-0","$[?(@.buy)].quantity"],"isExpanded":false},{"id":"sentinel-12","formula":"product","args":["sentinel-15","sentinel-11"],"isExpanded":false},{"id":"sentinel-72","formula":"list","args":["sentinel-73","sentinel-0"],"isExpanded":true},{"id":"sentinel-73","formula":"literalString","args":["This column contains a master shopping list of items regularly purchased."],"isExpanded":true},{"id":"sentinel-74","formula":"list","args":["sentinel-75","sentinel-9"],"isExpanded":true},{"id":"sentinel-75","formula":"literalString","args":["This column contains calculated result lists using JSONPath queries and formulas."],"isExpanded":true}];
            columnAtoms = ["sentinel-72", "sentinel-74"];
            break;
        case 'computing prime numbers':
            generateMultipleAtomIds(25);
            importAtoms = [{"id":"sentinel-0","formula":"dictionary","args":[{"key":"all integers to 121","value":"sentinel-1"},{"key":"multiples of  2","value":"sentinel-2"},{"key":"multiples of  3","value":"sentinel-3"},{"key":"multiples of  5","value":"sentinel-4"},{"key":"multiples of  7","value":"sentinel-5"},{"key":"multiples of 11","value":"sentinel-6"},{"key":"prime numbers to 11 (square root of 121)","value":"sentinel-7"},{"key":"range","value":"sentinel-8"},{"key":"union sets","value":"sentinel-9"}],"isExpanded":true},{"id":"sentinel-1","formula":"generate","args":["sentinel-10","sentinel-11","@"],"isExpanded":false},{"id":"sentinel-7","formula":"list","args":["sentinel-12","sentinel-13","sentinel-14","sentinel-15","sentinel-16"],"isExpanded":true},{"id":"sentinel-12","formula":"literalNumber","args":[2],"isExpanded":true},{"id":"sentinel-13","formula":"literalNumber","args":[3],"isExpanded":true},{"id":"sentinel-14","formula":"literalNumber","args":[5],"isExpanded":true},{"id":"sentinel-15","formula":"literalNumber","args":[7],"isExpanded":true},{"id":"sentinel-2","formula":"product","args":["sentinel-1","sentinel-12"],"isExpanded":false},{"id":"sentinel-3","formula":"product","args":["sentinel-1","sentinel-13"],"isExpanded":false},{"id":"sentinel-4","formula":"product","args":["sentinel-1","sentinel-14"],"isExpanded":false},{"id":"sentinel-5","formula":"product","args":["sentinel-1","sentinel-15"],"isExpanded":false},{"id":"sentinel-16","formula":"literalNumber","args":[11],"isExpanded":true},{"id":"sentinel-6","formula":"product","args":["sentinel-1","sentinel-16"],"isExpanded":false},{"id":"sentinel-9","formula":"dictionary","args":[{"key":"up to  3","value":"sentinel-17"},{"key":"up to  5","value":"sentinel-18"},{"key":"up to  7","value":"sentinel-19"},{"key":"up to 11","value":"sentinel-20"}],"isExpanded":true},{"id":"sentinel-17","formula":"union","args":["sentinel-2","sentinel-3"],"isExpanded":false},{"id":"sentinel-18","formula":"union","args":["sentinel-17","sentinel-4"],"isExpanded":false},{"id":"sentinel-19","formula":"union","args":["sentinel-18","sentinel-5"],"isExpanded":false},{"id":"sentinel-20","formula":"union","args":["sentinel-19","sentinel-6"],"isExpanded":false},{"id":"sentinel-21","formula":"uniqueLeft","args":["sentinel-1","sentinel-20"],"isExpanded":true},{"id":"sentinel-22","formula":"list","args":["sentinel-23","sentinel-24"],"isExpanded":true},{"id":"sentinel-24","formula":"dictionary","args":[{"key":"prime numbers to 121","value":"sentinel-21"}],"isExpanded":true},{"id":"sentinel-23","formula":"literalString","args":["This recipe uses multiply formulas and set logic to implement the Sieve of Eratosthenes, a method of computing prime numbers. The worker sets are in the second column."],"isExpanded":true},{"id":"sentinel-8","formula":"list","args":["sentinel-10","sentinel-11"],"isExpanded":true},{"id":"sentinel-10","formula":"literalNumber","args":[1],"isExpanded":true},{"id":"sentinel-11","formula":"literalNumber","args":[122],"isExpanded":true}];
            columnAtoms = ["sentinel-22", "sentinel-0"];
            break;
        case 'JSONPath examples':
            generateMultipleAtomIds(52);
            importAtoms = [{"id":"sentinel-0","formula":"dictionary","args":[{"key":"store","value":"sentinel-1"}],"isExpanded":true},{"id":"sentinel-1","formula":"dictionary","args":[{"key":"bicycle","value":"sentinel-2"},{"key":"book","value":"sentinel-3"}],"isExpanded":true},{"id":"sentinel-3","formula":"list","args":["sentinel-4","sentinel-5","sentinel-6","sentinel-7"],"isExpanded":true},{"id":"sentinel-4","formula":"dictionary","args":[{"key":"author","value":"sentinel-8"},{"key":"category","value":"sentinel-9"},{"key":"price","value":"sentinel-10"},{"key":"title","value":"sentinel-11"}],"isExpanded":true},{"id":"sentinel-9","formula":"literalString","args":["reference"],"isExpanded":true},{"id":"sentinel-8","formula":"literalString","args":["Nigel Rees"],"isExpanded":true},{"id":"sentinel-11","formula":"literalString","args":["Sayings of the Century"],"isExpanded":true},{"id":"sentinel-10","formula":"literalNumber","args":[8.95],"isExpanded":true},{"id":"sentinel-5","formula":"dictionary","args":[{"key":"author","value":"sentinel-12"},{"key":"category","value":"sentinel-13"},{"key":"price","value":"sentinel-14"},{"key":"title","value":"sentinel-15"}],"isExpanded":true},{"id":"sentinel-13","formula":"literalString","args":["fiction"],"isExpanded":true},{"id":"sentinel-12","formula":"literalString","args":["Evelyn Waugh"],"isExpanded":true},{"id":"sentinel-15","formula":"literalString","args":["Sword of Honour"],"isExpanded":true},{"id":"sentinel-14","formula":"literalNumber","args":[12.99],"isExpanded":true},{"id":"sentinel-6","formula":"dictionary","args":[{"key":"author","value":"sentinel-16"},{"key":"category","value":"sentinel-17"},{"key":"isbn","value":"sentinel-18"},{"key":"price","value":"sentinel-19"},{"key":"title","value":"sentinel-20"}],"isExpanded":true},{"id":"sentinel-17","formula":"literalString","args":["fiction"],"isExpanded":true},{"id":"sentinel-16","formula":"literalString","args":["Herman Melville"],"isExpanded":true},{"id":"sentinel-20","formula":"literalString","args":["Moby Dick"],"isExpanded":true},{"id":"sentinel-18","formula":"literalString","args":["0-553-21311-3"],"isExpanded":true},{"id":"sentinel-19","formula":"literalNumber","args":[8.99],"isExpanded":true},{"id":"sentinel-7","formula":"dictionary","args":[{"key":"author","value":"sentinel-21"},{"key":"category","value":"sentinel-22"},{"key":"isbn","value":"sentinel-23"},{"key":"price","value":"sentinel-24"},{"key":"title","value":"sentinel-25"}],"isExpanded":true},{"id":"sentinel-22","formula":"literalString","args":["fiction"],"isExpanded":true},{"id":"sentinel-21","formula":"literalString","args":["J. R. R. Tolkien"],"isExpanded":true},{"id":"sentinel-25","formula":"literalString","args":["The Lord of the Rings"],"isExpanded":true},{"id":"sentinel-23","formula":"literalString","args":["0-395-19395-8"],"isExpanded":true},{"id":"sentinel-24","formula":"literalNumber","args":[22.99],"isExpanded":true},{"id":"sentinel-2","formula":"dictionary","args":[{"key":"color","value":"sentinel-26"},{"key":"price","value":"sentinel-27"}],"isExpanded":true},{"id":"sentinel-26","formula":"literalString","args":["red"],"isExpanded":true},{"id":"sentinel-27","formula":"literalNumber","args":[19.95],"isExpanded":true},{"id":"sentinel-28","formula":"list","args":["sentinel-29","sentinel-0"],"isExpanded":true},{"id":"sentinel-29","formula":"literalString","args":["Example data and queries is borrowed from, and credit goes to, https://github.com/s3u/JSONPath - visit for additional documentation and explanations for examples"],"isExpanded":true},{"id":"sentinel-30","formula":"dictionary","args":[{"key":" 1 - authors of all books in the store","value":"sentinel-31"},{"key":" 2 - all authors","value":"sentinel-32"},{"key":" 3 - all things in the store","value":"sentinel-33"},{"key":" 4 - price of everything in the store","value":"sentinel-34"},{"key":" 5 - the third book","value":"sentinel-35"},{"key":" 6 - the last book in order","value":"sentinel-36"},{"key":" 7 - the first two books","value":"sentinel-37"},{"key":" 8 - categories and authors of all books","value":"sentinel-38"},{"key":" 9 - filter all books with an ISBN","value":"sentinel-39"},{"key":"10 - filter all books cheaper than 10.00","value":"sentinel-40"},{"key":"11 - all property values of objects whose property is price and which does not equal 8.95","value":"sentinel-41"},{"key":"12 - the root of the object","value":"sentinel-42"},{"key":"13 - all members of the JSON structure beneath the root","value":"sentinel-43"},{"key":"14 - parents of those specific items with a price greater than 19","value":"sentinel-44"},{"key":"15 - property names of the store sub-object","value":"sentinel-45"},{"key":"16 - all categories of books where the parent object of the book has a bicycle child whose color is red","value":"sentinel-46"},{"key":"17 - all children of \"book\" except for \"category\" ones","value":"sentinel-47"},{"key":"18 - all books whose property is not 0","value":"sentinel-48"},{"key":"19 - grandchildren of store whose parent property is not book","value":"sentinel-49"},{"key":"20 - property values of all book instances whereby the parent property of these values is not 0","value":"sentinel-50"},{"key":"21 - numeric values within the book array","value":"sentinel-51"}],"isExpanded":true},{"id":"sentinel-31","formula":"jsonPath","args":["sentinel-0","$.store.book[*].author"],"isExpanded":false},{"id":"sentinel-32","formula":"jsonPath","args":["sentinel-0","$..author"],"isExpanded":false},{"id":"sentinel-33","formula":"jsonPath","args":["sentinel-0","$.store.*"],"isExpanded":false},{"id":"sentinel-34","formula":"jsonPath","args":["sentinel-0","$.store..price"],"isExpanded":false},{"id":"sentinel-35","formula":"jsonPath","args":["sentinel-0","$..book[2]"],"isExpanded":false},{"id":"sentinel-36","formula":"jsonPath","args":["sentinel-0","$..book[(@.length-1)]"],"isExpanded":false},{"id":"sentinel-37","formula":"jsonPath","args":["sentinel-0","$..book[:2]"],"isExpanded":false},{"id":"sentinel-38","formula":"jsonPath","args":["sentinel-0","$..book[*][category,author]"],"isExpanded":false},{"id":"sentinel-39","formula":"jsonPath","args":["sentinel-0","$..book[?(@.isbn)]"],"isExpanded":false},{"id":"sentinel-40","formula":"jsonPath","args":["sentinel-0","$..book[?(@.price<10)]"],"isExpanded":false},{"id":"sentinel-41","formula":"jsonPath","args":["sentinel-0","$..*[?(@property === 'price' && @ !== 8.95)]"],"isExpanded":false},{"id":"sentinel-42","formula":"jsonPath","args":["sentinel-0","$"],"isExpanded":false},{"id":"sentinel-43","formula":"jsonPath","args":["sentinel-0","$..*"],"isExpanded":false},{"id":"sentinel-44","formula":"jsonPath","args":["sentinel-0","$..[?(@.price>19)]^"],"isExpanded":false},{"id":"sentinel-45","formula":"jsonPath","args":["sentinel-0","$.store.*~"],"isExpanded":false},{"id":"sentinel-46","formula":"jsonPath","args":["sentinel-0","$..book[?(@parent.bicycle && @parent.bicycle.color === \"red\")].category"],"isExpanded":false},{"id":"sentinel-47","formula":"jsonPath","args":["sentinel-0","$..book.*[?(@property !== \"category\")]"],"isExpanded":false},{"id":"sentinel-48","formula":"jsonPath","args":["sentinel-0","$..book[?(@property !== 0)]"],"isExpanded":false},{"id":"sentinel-49","formula":"jsonPath","args":["sentinel-0","$.store.*[?(@parentProperty !== \"book\")]"],"isExpanded":false},{"id":"sentinel-50","formula":"jsonPath","args":["sentinel-0","$..book.*[?(@parentProperty !== 0)]"],"isExpanded":false},{"id":"sentinel-51","formula":"jsonPath","args":["sentinel-0","$..book..*@number()"],"isExpanded":false}];
            columnAtoms = ["sentinel-28", "sentinel-30"];
            break;
    }
    
    var sentinelMatches = function(element) {
        if (typeof element == 'string') {
            if (element.match(/sentinel-\d+/)) {
                return true;
            }
        }
        return false;
    };
    var sentinelReplace = function(element) {
        var n = parseInt(element.match(/\d+/)[0]);
        return element.replace(/sentinel-\d+/, atomIds[n]);
    };
    
    $.each(importAtoms, function(i, atom) {
        if (sentinelMatches(atom.id)) {
            atom.id = sentinelReplace(atom.id);
        }
        
        if (atom.formula == 'dictionary') {
            $.each(atom.args, function(i, arg) {
                if (sentinelMatches(arg.value)) {
                    arg.value = sentinelReplace(arg.value);
                }
            });
        } else {
            for (var i = 0; i < atom.args.length; i++) {
                if (sentinelMatches(atom.args[i])) {
                    atom.args[i] = sentinelReplace(atom.args[i]);
                }
            }
        }
    });
    for (var i = 0; i < columnAtoms.length; i++) {
        if (sentinelMatches(columnAtoms[i])) {
            columnAtoms[i] = sentinelReplace(columnAtoms[i]);
        }
    }
    
    action.steps.push({
        predicate: 'import',
        atoms: importAtoms,
        columnAtoms: columnAtoms
    });
    
    if (typeof actionProvided == 'undefined') {
        actionsHistory[action.id] = action;
        advanceToRevision(action.id);
        refresh();
        
        setStatusCenter('cookbook');
    }
};

var init = function() {
    if (!bowser.msie) { // works fine on Edge
        window.onbeforeunload = confirmOnPageExit;
    }
    
    $(document).on('mousemove touchmove', function(event) {
        moveMouseMove(event);
    });
    $(document).on('mouseup touchend', function(event) {
        moveMouseUp(event);
    });
    $(window).on('scroll', function(event) {
        event.preventDefault();
        recalculateToolbarSticky();
    });
    $('.menu').on('mouseenter', function() {
        menuMouseEnter($(this));
    });
    $('.menu').on('mouseleave', function() {
        menuMouseLeave($(this));
    });
    $('.menu-undo').on('click', function() {
        if (uiState == 'normal') {
            undo();
        }
    });
    $('.menu-redo').on('click', function() {
        if (uiState == 'normal') {
            redo();
        }
    });
    $('.menu-revision').on('click', function() {
        if (uiState == 'normal') {
            pickRevision();
        }
    });
    $('.menu-wrap').on('click', function() {
        if (uiState == 'normal') {
            wrap();
        }
    });
    $('.menu-collapse').on('click', function() {
        collapseAll();
    });
    $('.menu-expand').on('click', function() {
        expandAll();
    });
    $('.menu-clear').on('click', function() {
        if (uiState == 'normal') {
            clearAll();
        }
    });
    $('.menu-share').on('click', function() {
        if (uiState == 'normal') {
            share();
        }
    });
    $('.menu-cookbook').on('click', function() {
        if (uiState == 'normal') {
            cookbook();
        }
    });
    $('.dropdown-share .link').on('click', function() {
        dropdownCancel();
    });
    $('.menu-name input').on('change keyup', function() {
        changeName();
    });
    $('.dropdown-mask').on('click', function() {
        dropdownCancel();
    });
    $('.scroll-left').on('click', function() {
        scrollLeft();
    });
    $('.scroll-right').on('click', function() {
        scrollRight();
    });
    $('.scroll-left').on('mousemove', function() {
        if (scrollLeftAllowed) {
            $(this).addClass('scroll-left-hover');
        }
        scrollLeftIfMoveDragging();
    });
    $('.scroll-left').on('mouseleave', function() {
        $(this).removeClass('scroll-left-hover');
    });
    $('.scroll-right').on('mousemove', function() {
        if (scrollRightAllowed) {
            $(this).addClass('scroll-right-hover');
        }
        scrollRightIfMoveDragging();
    });
    $('.scroll-right').on('mouseleave', function() {
        $(this).removeClass('scroll-right-hover');
    });
    $('.status input[name="done"]').on('click', function() {
        pickFormulaDone();
    });
    $('.status input[name="cancel"]').on('click', function() {
        pickFormulaCancel();
    });
    $('.status input[name="move"]').on('click', function() {
        pickFormulaMove();
    });
    $('.header-link-about a').on('click', function() {
        if (uiState == 'normal') {
            $.fancybox($('.prompt-about').prop('outerHTML'), {openEffect: 'none', closeEffect: 'none'});
        }
    });
    $('.header-link-faq a').on('click', function() {
        if (uiState == 'normal') {
            $.fancybox($('.prompt-faq').prop('outerHTML'), {openEffect: 'none', closeEffect: 'none'});
        }
    });
    $('.header-link-source a').on('click', function() {
        if (uiState == 'normal') {
            // $.fancybox($('.prompt-source').prop('outerHTML'), {openEffect: 'none', closeEffect: 'none'});
        }
    });
    
    $('.cookbook').each(function() {
        var recipe = $(this).data('cookbook-recipe');
        $(this).find('a').on('click', function() {
            cookbookRecipe(recipe);
        });
    });
    
    if (window.location.pathname.indexOf('/private/') != -1) {
        isPrivate = true;
        $('.header-notice').show();
        $('.header-notice').html($('.header-notice-text-private').html());
        $('.menu-share').addClass('menu-disabled');
        $('.menu-name').hide();
    }
    
    $('.button-howto').on('click', function() {
        $.fancybox($('.prompt-howto').prop('outerHTML'), {openEffect: 'none', closeEffect: 'none'});
    });
    
    var backgroundRecalculateColumnLayout = function() {
        recalculateColumnLayout(false);
        setTimeout(backgroundRecalculateColumnLayout, 16);
    };
    backgroundRecalculateColumnLayout();
    
    var backgroundRecalculateToolbarSticky = function() {
        recalculateToolbarSticky();
        setTimeout(backgroundRecalculateToolbarSticky, 100);
    };
    backgroundRecalculateToolbarSticky();
    
    iosUxHack();
    
    // comment to disable syncing
    setTimeout(syncEventLoop, 50);
    
    var documentIdMatchNoClone = window.location.pathname.match(/\/docs\/(.+)/);
    var documentIdMatchClone = window.location.pathname.match(/\/docs\/(.+)\/clone/);
    var documentIdMatch;
    if (documentIdMatchClone) {
        documentIdMatch = documentIdMatchClone[1];
    } else {
        if (documentIdMatchNoClone) {
            documentIdMatch = documentIdMatchNoClone[1];
        }
    }
    if (documentIdMatch) {
        documentId = documentIdMatch;
        loadInitialData();
    } else {
        
        if (!isPrivate) {
            history.replaceState({}, '', window.location.protocol + '//' + window.location.host + '/');
        }
        
        var action = $.extend(true, {}, actionTemplate);
        action.id = generateActionId();
        action.basedOn = actionsHistoryPointer;
        action.description = 'Initialize';
        action.descriptionPast = 'initialized';
        
        cookbookRecipe('initialize', action);
        
        actionsHistory['0'] = action;
        processAction(actionsHistory['0']);
        actionsHistory['0'].fullStateAtoms = $.extend(true, {}, atoms);
        refresh();
    }
};

init();

// for debugging only

var killSyncing = function() {
    isPrivate = true;
};

window.datascribbler = {
    atoms: function() { return $.extend(true, {}, atoms); },
    actionsHistory: function() { return $.extend(true, {}, actionsHistory); },
    actionsHistoryPointer: actionsHistoryPointer,
    maximumActionsHistoryId: maximumActionsHistoryId,
    inUpdateCall: inUpdateCall,
    inSaveCall: inSaveCall,
    refresh: refresh,
    advanceToRevision: advanceToRevision,
    processAction: processAction,
    deleteAtom: deleteAtom,
    dictionaryCompare: dictionaryCompare,
    recalculate: recalculate,
    recalculateAtom: recalculateAtom,
    render: render,
    renderData: renderData,
    boxAtom: boxAtom,
    insertDataFromJson: insertDataFromJson,
    insertDataFromJsonIterate: insertDataFromJsonIterate,
    generateAtomId: generateAtomId,
    generateActionId: generateActionId,
    killSyncing: killSyncing,
    setStatusCenter: setStatusCenter,
    changeHighlight: changeHighlight
};

});
