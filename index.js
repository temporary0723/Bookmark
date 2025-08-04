// 북마크 매니저 확장 - SillyTavern Extension
// 채팅 메시지에 북마크를 추가하고 관리할 수 있는 기능 제공

import {
    eventSource,
    event_types,
    chat,
    getRequestHeaders,
    saveSettingsDebounced,
    substituteParams,
} from '../../../../script.js';

import {
    getContext,
    extension_settings,
    saveMetadataDebounced,
} from '../../../extensions.js';

import {
    POPUP_TYPE,
    callGenericPopup,
    POPUP_RESULT,
} from '../../../popup.js';

import {
    uuidv4,
    timestampToMoment,
} from '../../../utils.js';

// 확장 이름 및 상수 정의
const pluginName = 'bookmark-manager';
const extensionFolderPath = `scripts/extensions/third-party/Bookmark`;

// 메시지 버튼 HTML (북마크 아이콘)
const messageButtonHtml = `
    <div class="mes_button bookmark-icon interactable" title="북마크 추가" tabindex="0">
        <i class="fa-solid fa-bookmark"></i>
    </div>
`;

// 북마크 데이터 저장소
let bookmarks = [];

// 현재 열린 모달
let currentModal = null;

/**
 * 로컬 스토리지에서 북마크 로드
 */
function loadBookmarks() {
    try {
        const savedBookmarks = localStorage.getItem('st_bookmarks');
        if (savedBookmarks) {
            bookmarks = JSON.parse(savedBookmarks);
        }
    } catch (error) {
        console.error('북마크 로드 실패:', error);
        bookmarks = [];
    }
}

/**
 * 로컬 스토리지에 북마크 저장
 */
function saveBookmarks() {
    try {
        localStorage.setItem('st_bookmarks', JSON.stringify(bookmarks));
    } catch (error) {
        console.error('북마크 저장 실패:', error);
    }
}

/**
 * 메시지 ID로 스크롤 이동
 */
function scrollToMessage(messageId) {
    const messageElement = $(`.mes[mesid="${messageId}"]`);
    if (messageElement.length > 0) {
        messageElement[0].scrollIntoView({ 
            behavior: 'smooth', 
            block: 'center' 
        });
        
        // 강조 효과
        messageElement.addClass('highlight-bookmark');
        setTimeout(() => {
            messageElement.removeClass('highlight-bookmark');
        }, 2000);
    } else {
        toastr.warning(`메시지 ID ${messageId}를 찾을 수 없습니다.`);
    }
}

/**
 * 북마크 추가 모달 생성
 */
async function createBookmarkModal(messageId) {
    console.log(`[Bookmark] createBookmarkModal 함수 시작 - messageId: ${messageId}`);
    
    const modalHtml = `
        <div class="bookmark-modal-backdrop">
            <div class="bookmark-modal">
                <div class="bookmark-modal-header">
                    <h3>북마크 추가</h3>
                    <button class="bookmark-modal-close" title="닫기">×</button>
                </div>
                <div class="bookmark-modal-body">
                    <div class="form-group">
                        <label for="bookmark-name">북마크 이름:</label>
                        <input type="text" id="bookmark-name" class="text_pole" placeholder="북마크 이름을 입력하세요">
                    </div>
                    <div class="form-group">
                        <label for="bookmark-description">설명:</label>
                        <textarea id="bookmark-description" class="text_pole" rows="3" placeholder="북마크 설명을 입력하세요"></textarea>
                    </div>
                    <div class="form-group">
                        <label>메시지 ID: ${messageId}</label>
                    </div>
                </div>
                <div class="bookmark-modal-footer">
                    <button class="bookmark-confirm-btn menu_button">확인</button>
                    <button class="bookmark-cancel-btn menu_button">취소</button>
                </div>
            </div>
        </div>
    `;

    // 기존 모달 제거
    if (currentModal) {
        console.log('[Bookmark] 기존 모달 제거');
        currentModal.remove();
    }

    console.log('[Bookmark] 새 모달 HTML 생성 완료');
    currentModal = $(modalHtml);
    console.log('[Bookmark] 모달 DOM 요소 생성:', currentModal[0]);
    
    $('body').append(currentModal);
    console.log('[Bookmark] 모달을 body에 추가 완료');

    // 애니메이션 효과
    setTimeout(() => {
        console.log('[Bookmark] 모달 애니메이션 시작');
        currentModal.addClass('visible');
        currentModal.find('.bookmark-modal').addClass('visible');
        console.log('[Bookmark] 모달 표시 완료');
    }, 10);

    // 이벤트 핸들러
    console.log('[Bookmark] 모달 이벤트 핸들러 등록 시작');
    currentModal.find('.bookmark-modal-close, .bookmark-cancel-btn').on('click', closeBookmarkModal);
    
    currentModal.find('.bookmark-confirm-btn').on('click', function() {
        console.log('[Bookmark] 확인 버튼 클릭됨');
        const name = $('#bookmark-name').val().trim();
        const description = $('#bookmark-description').val().trim();
        
        console.log(`[Bookmark] 입력값 - 이름: "${name}", 설명: "${description}"`);
        
        if (!name) {
            console.log('[Bookmark] 북마크 이름이 비어있음');
            toastr.error('북마크 이름을 입력해주세요.');
            return;
        }

        // 북마크 추가
        console.log(`[Bookmark] 북마크 추가 시작 - messageId: ${messageId}`);
        addBookmark(messageId, name, description);
        closeBookmarkModal();
        toastr.success('북마크가 추가되었습니다.');
    });
    
    console.log('[Bookmark] 모달 이벤트 핸들러 등록 완료');

    // 엔터키로 확인
    currentModal.find('input, textarea').on('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            currentModal.find('.bookmark-confirm-btn').click();
        }
    });

    // 첫 번째 입력 필드에 포커스
    setTimeout(() => {
        $('#bookmark-name').focus();
    }, 100);
}

/**
 * 북마크 모달 닫기
 */
function closeBookmarkModal() {
    console.log('[Bookmark] 모달 닫기 시작');
    if (currentModal) {
        console.log('[Bookmark] 모달 애니메이션 제거 시작');
        currentModal.removeClass('visible');
        currentModal.find('.bookmark-modal').removeClass('visible');
        
        setTimeout(() => {
            console.log('[Bookmark] 모달 DOM에서 제거');
            currentModal.remove();
            currentModal = null;
        }, 300);
    } else {
        console.log('[Bookmark] 닫을 모달이 없음');
    }
}

/**
 * 북마크 추가
 */
function addBookmark(messageId, name, description) {
    console.log(`[Bookmark] addBookmark 함수 시작 - messageId: ${messageId}, name: "${name}"`);
    
    const bookmark = {
        id: uuidv4(),
        messageId: parseInt(messageId),
        name: name,
        description: description,
        createdAt: new Date().toISOString()
    };

    console.log('[Bookmark] 북마크 객체 생성:', bookmark);
    
    bookmarks.push(bookmark);
    bookmarks.sort((a, b) => a.messageId - b.messageId);
    
    console.log(`[Bookmark] 북마크 배열에 추가 완료. 총 ${bookmarks.length}개`);
    
    saveBookmarks();
    console.log('[Bookmark] 북마크 저장 완료');
}

/**
 * 북마크 수정
 */
function editBookmark(bookmarkId, name, description) {
    const bookmark = bookmarks.find(b => b.id === bookmarkId);
    if (bookmark) {
        bookmark.name = name;
        bookmark.description = description;
        saveBookmarks();
    }
}

/**
 * 북마크 삭제
 */
function deleteBookmark(bookmarkId) {
    const index = bookmarks.findIndex(b => b.id === bookmarkId);
    if (index !== -1) {
        bookmarks.splice(index, 1);
        saveBookmarks();
    }
}

/**
 * 북마크 목록 모달 생성
 */
async function createBookmarkListModal() {
    const bookmarkList = bookmarks.map(bookmark => `
        <div class="bookmark-item" data-bookmark-id="${bookmark.id}">
            <div class="bookmark-content" data-message-id="${bookmark.messageId}">
                <div class="bookmark-header">
                    <span class="bookmark-name">${bookmark.name}</span>
                    <span class="bookmark-message-id">ID: ${bookmark.messageId}</span>
                </div>
                <div class="bookmark-description">${bookmark.description || '설명 없음'}</div>
                <div class="bookmark-date">${new Date(bookmark.createdAt).toLocaleString()}</div>
            </div>
            <div class="bookmark-actions">
                <button class="bookmark-edit-btn menu_button" title="수정">
                    <i class="fa-solid fa-pencil"></i>
                </button>
                <button class="bookmark-delete-btn menu_button" title="삭제">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        </div>
    `).join('');

    const modalHtml = `
        <div class="bookmark-list-modal-backdrop">
            <div class="bookmark-list-modal">
                <div class="bookmark-modal-header">
                    <h3>북마크 목록</h3>
                    <button class="bookmark-modal-close" title="닫기">×</button>
                </div>
                <div class="bookmark-modal-body">
                    ${bookmarks.length === 0 
                        ? '<div class="no-bookmarks">저장된 북마크가 없습니다.</div>' 
                        : `<div class="bookmark-list">${bookmarkList}</div>`
                    }
                </div>
            </div>
        </div>
    `;

    // 기존 모달 제거
    if (currentModal) {
        currentModal.remove();
    }

    currentModal = $(modalHtml);
    $('body').append(currentModal);

    // 애니메이션 효과
    setTimeout(() => {
        currentModal.addClass('visible');
        currentModal.find('.bookmark-list-modal').addClass('visible');
    }, 10);

    // 이벤트 핸들러
    currentModal.find('.bookmark-modal-close').on('click', closeBookmarkModal);
    
    // 북마크 클릭으로 메시지 이동
    currentModal.find('.bookmark-content').on('click', function() {
        const messageId = $(this).data('message-id');
        closeBookmarkModal();
        setTimeout(() => {
            scrollToMessage(messageId);
        }, 100);
    });

    // 수정 버튼
    currentModal.find('.bookmark-edit-btn').on('click', function(e) {
        e.stopPropagation();
        const bookmarkId = $(this).closest('.bookmark-item').data('bookmark-id');
        editBookmarkModal(bookmarkId);
    });

    // 삭제 버튼
    currentModal.find('.bookmark-delete-btn').on('click', function(e) {
        e.stopPropagation();
        const bookmarkId = $(this).closest('.bookmark-item').data('bookmark-id');
        confirmDeleteBookmark(bookmarkId);
    });
}

/**
 * 북마크 수정 모달
 */
async function editBookmarkModal(bookmarkId) {
    const bookmark = bookmarks.find(b => b.id === bookmarkId);
    if (!bookmark) return;

    const modalHtml = `
        <div class="bookmark-modal-backdrop">
            <div class="bookmark-modal">
                <div class="bookmark-modal-header">
                    <h3>북마크 수정</h3>
                    <button class="bookmark-modal-close" title="닫기">×</button>
                </div>
                <div class="bookmark-modal-body">
                    <div class="form-group">
                        <label for="edit-bookmark-name">북마크 이름:</label>
                        <input type="text" id="edit-bookmark-name" class="text_pole" value="${bookmark.name}">
                    </div>
                    <div class="form-group">
                        <label for="edit-bookmark-description">설명:</label>
                        <textarea id="edit-bookmark-description" class="text_pole" rows="3">${bookmark.description}</textarea>
                    </div>
                    <div class="form-group">
                        <label>메시지 ID: ${bookmark.messageId}</label>
                    </div>
                </div>
                <div class="bookmark-modal-footer">
                    <button class="bookmark-confirm-btn menu_button">저장</button>
                    <button class="bookmark-cancel-btn menu_button">취소</button>
                </div>
            </div>
        </div>
    `;

    // 기존 모달 제거
    if (currentModal) {
        currentModal.remove();
    }

    currentModal = $(modalHtml);
    $('body').append(currentModal);

    // 애니메이션 효과
    setTimeout(() => {
        currentModal.addClass('visible');
        currentModal.find('.bookmark-modal').addClass('visible');
    }, 10);

    // 이벤트 핸들러
    currentModal.find('.bookmark-modal-close, .bookmark-cancel-btn').on('click', () => {
        closeBookmarkModal();
        setTimeout(() => createBookmarkListModal(), 100);
    });
    
    currentModal.find('.bookmark-confirm-btn').on('click', function() {
        const name = $('#edit-bookmark-name').val().trim();
        const description = $('#edit-bookmark-description').val().trim();
        
        if (!name) {
            toastr.error('북마크 이름을 입력해주세요.');
            return;
        }

        editBookmark(bookmarkId, name, description);
        closeBookmarkModal();
        toastr.success('북마크가 수정되었습니다.');
        setTimeout(() => createBookmarkListModal(), 100);
    });

    // 첫 번째 입력 필드에 포커스
    setTimeout(() => {
        $('#edit-bookmark-name').focus();
    }, 100);
}

/**
 * 북마크 삭제 확인
 */
async function confirmDeleteBookmark(bookmarkId) {
    const bookmark = bookmarks.find(b => b.id === bookmarkId);
    if (!bookmark) return;

    const result = await callGenericPopup(
        `"${bookmark.name}" 북마크를 삭제하시겠습니까?`,
        POPUP_TYPE.CONFIRM
    );

    if (result === POPUP_RESULT.AFFIRMATIVE) {
        deleteBookmark(bookmarkId);
        toastr.success('북마크가 삭제되었습니다.');
        
        // 목록 모달 새로고침
        closeBookmarkModal();
        setTimeout(() => createBookmarkListModal(), 100);
    }
}

/**
 * 메시지에 북마크 아이콘 추가
 */
function addBookmarkIconsToMessages() {
    $('#chat').find('.mes').each(function() {
        const messageElement = $(this);
        const extraButtonsContainer = messageElement.find('.extraMesButtons');
        
        // extraMesButtons 컨테이너가 있고 이미 버튼이 없으면 추가
        if (extraButtonsContainer.length && !extraButtonsContainer.find('.bookmark-icon').length) {
            extraButtonsContainer.prepend(messageButtonHtml);
        }
    });
}

/**
 * 메시지 업데이트 핸들러
 */
function handleMessageUpdate() {
    setTimeout(() => {
        addBookmarkIconsToMessages();
    }, 100);
}

/**
 * 요술봉 메뉴에 버튼 추가
 */
async function addToWandMenu() {
    try {
        const buttonHtml = await $.get(`${extensionFolderPath}/button.html`);
        
        const extensionsMenu = $("#extensionsMenu");
        if (extensionsMenu.length > 0) {
            extensionsMenu.append(buttonHtml);
            $("#bookmark_manager_button").on("click", createBookmarkListModal);
        } else {
            setTimeout(addToWandMenu, 1000);
        }
    } catch (error) {
        console.error('요술봉 메뉴 버튼 추가 실패:', error);
    }
}

/**
 * 확장 초기화
 */
function initializeBookmarkManager() {
    console.log('[Bookmark] === 북마크 매니저 초기화 시작 ===');
    
    // 북마크 데이터 로드
    loadBookmarks();
    console.log(`[Bookmark] 북마크 데이터 로드 완료: ${bookmarks.length}개`);
    
    // 기존 메시지에 아이콘 추가
    addBookmarkIconsToMessages();
    
    // 이벤트 리스너 설정
    eventSource.on(event_types.MESSAGE_RECEIVED, handleMessageUpdate);
    eventSource.on(event_types.MESSAGE_SWIPED, handleMessageUpdate);
    eventSource.on(event_types.CHAT_CHANGED, handleMessageUpdate);
    console.log('[Bookmark] 이벤트 리스너 등록 완료');
    
    // 북마크 아이콘 클릭 이벤트
    $(document).on('click', '.bookmark-icon', function(event) {
        console.log('[Bookmark] 북마크 아이콘 클릭 이벤트 발생');
        event.preventDefault();
        event.stopPropagation();
        
        // 클릭된 메시지의 인덱스 찾기
        const messageElement = $(this).closest('.mes');
        const messageId = messageElement.attr('mesid');
        
        console.log(`[Bookmark] 클릭된 요소:`, this);
        console.log(`[Bookmark] 찾은 메시지 요소:`, messageElement[0]);
        console.log(`[Bookmark] 메시지 ID: ${messageId}`);
        
        if (messageId !== undefined) {
            console.log(`[Bookmark] createBookmarkModal(${messageId}) 호출`);
            createBookmarkModal(messageId);
        } else {
            console.error('[Bookmark] 메시지 ID를 찾을 수 없습니다');
        }
    });
    
    // 요술봉 메뉴에 버튼 추가
    setTimeout(addToWandMenu, 1000);
    
    console.log('[Bookmark] === 북마크 매니저 초기화 완료 ===');
}

// jQuery 준비 완료 시 초기화
jQuery(() => {
    console.log('[Bookmark] jQuery 준비 완료, 북마크 매니저 초기화 시작');
    initializeBookmarkManager();
});