/**
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2013, Dash Industry Forum.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *  * Redistributions of source code must retain the above copyright notice, this
 *  list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *  this list of conditions and the following disclaimer in the documentation and/or
 *  other materials provided with the distribution.
 *  * Neither the name of Dash Industry Forum nor the names of its
 *  contributors may be used to endorse or promote products derived from this software
 *  without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS AS IS AND ANY
 *  EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 *  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 *  IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
 *  INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 *  NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 *  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 *  WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 *  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *  POSSIBILITY OF SUCH DAMAGE.
 */

import PlayList from '../vo/metrics/PlayList.js';
import PlaybackController from './PlaybackController.js';
import AbrController from './AbrController.js';
import BufferController from './BufferController.js';
import BufferLevelRule from '../rules/scheduling/BufferLevelRule.js';
import NextFragmentRequestRule from '../rules/scheduling/NextFragmentRequestRule.js';
import TextSourceBuffer from '../TextSourceBuffer.js';
import MetricsModel from '../models/MetricsModel.js';
import DashMetrics from '../../dash/DashMetrics.js';
import DashAdapter from '../../dash/DashAdapter.js';
import SourceBufferController from '../controllers/SourceBufferController.js';
import VirtualBuffer from '../VirtualBuffer.js';
import LiveEdgeFinder from '../utils/LiveEdgeFinder.js';
import EventBus from '../../core/EventBus.js';
import Events from '../../core/events/Events.js';
import FactoryMaker from '../../core/FactoryMaker.js';
import Debug from '../../core/Debug.js';

function ScheduleController(config) {

    let context = this.context;
    let log = Debug(context).getInstance().log;
    let eventBus = EventBus(context).getInstance();

    let metricsModel = config.metricsModel;
    let manifestModel = config.manifestModel;
    let adapter = config.adapter;
    let dashMetrics = config.dashMetrics;
    let dashManifestModel = config.dashManifestModel;
    let timelineConverter = config.timelineConverter;
    let mediaPlayerModel = config.mediaPlayerModel;

    let instance,
        type,
        ready,
        fragmentModel,
        isDynamic,
        currentRepresentationInfo,
        initialPlayback,
        isStopped,
        playListMetrics,
        playListTraceMetrics,
        playListTraceMetricsClosed,
        isFragmentLoading,
        timeToLoadDelay,
        validateTimeout,
        seekTarget,
        playbackController,
        abrController,
        streamProcessor,
        fragmentController,
        liveEdgeFinder,
        bufferController,
        bufferLevelRule,
        nextFragmentRequestRule,
        scheduleWhilePaused;


    function setup() {
        initialPlayback = true;
        isStopped = false;
        playListMetrics = null;
        playListTraceMetrics = null;
        playListTraceMetricsClosed = true;
        isFragmentLoading = false;
        timeToLoadDelay = 0;
        seekTarget = NaN;
    }

    function initialize(Type, StreamProcessor) {
        type = Type;
        streamProcessor = StreamProcessor;
        liveEdgeFinder = LiveEdgeFinder(context).getInstance();
        playbackController = PlaybackController(context).getInstance();
        abrController = AbrController(context).getInstance();
        fragmentController = streamProcessor.getFragmentController();
        bufferController = streamProcessor.getBufferController();
        fragmentModel = fragmentController.getModel(this);
        isDynamic = streamProcessor.isDynamic();
        scheduleWhilePaused = mediaPlayerModel.getScheduleWhilePaused();

        bufferLevelRule = BufferLevelRule(context).create({
            dashMetrics: DashMetrics(context).getInstance(),
            metricsModel: MetricsModel(context).getInstance(),
            textSourceBuffer: TextSourceBuffer(context).getInstance()
        });

        nextFragmentRequestRule = NextFragmentRequestRule(context).create({
            adapter: DashAdapter(context).getInstance(),
            sourceBufferController: SourceBufferController(context).getInstance(),
            virtualBuffer: VirtualBuffer(context).getInstance(),
            textSourceBuffer: TextSourceBuffer(context).getInstance()

        });


        if (dashManifestModel.getIsTextTrack(type)) {
            eventBus.on(Events.TIMED_TEXT_REQUESTED, onTimedTextRequested, this);
        }

        eventBus.on(Events.LIVE_EDGE_SEARCH_COMPLETED, onLiveEdgeSearchCompleted, this);
        eventBus.on(Events.QUALITY_CHANGED, onQualityChanged, this);
        eventBus.on(Events.DATA_UPDATE_STARTED, onDataUpdateStarted, this);
        eventBus.on(Events.DATA_UPDATE_COMPLETED, onDataUpdateCompleted, this);
        eventBus.on(Events.FRAGMENT_LOADING_COMPLETED, onFragmentLoadingCompleted, this);
        eventBus.on(Events.STREAM_COMPLETED, onStreamCompleted, this);
        eventBus.on(Events.STREAM_INITIALIZED, onStreamInitialized, this);
        eventBus.on(Events.BUFFER_LEVEL_STATE_CHANGED, onBufferLevelStateChanged, this);
        eventBus.on(Events.BUFFER_CLEARED, onBufferCleared, this);
        eventBus.on(Events.BYTES_APPENDED, onBytesAppended, this);
        eventBus.on(Events.INIT_REQUESTED, onInitRequested, this);
        eventBus.on(Events.QUOTA_EXCEEDED, onQuotaExceeded, this);
        eventBus.on(Events.BUFFER_LEVEL_STATE_CHANGED, onBufferLevelStateChanged, this);
        eventBus.on(Events.PLAYBACK_STARTED, onPlaybackStarted, this);
        eventBus.on(Events.PLAYBACK_SEEKING, onPlaybackSeeking, this);
        eventBus.on(Events.PLAYBACK_RATE_CHANGED, onPlaybackRateChanged, this);
        eventBus.on(Events.URL_RESOLUTION_FAILED, onURLResolutionFailed, this);
    }

    function clearPlayListTraceMetrics(endTime, stopreason) {
        var duration = 0;
        var startTime = null;

        if (playListMetrics && playListTraceMetricsClosed === false) {
            startTime = playListTraceMetrics.start;
            duration = endTime.getTime() - startTime.getTime();

            playListTraceMetrics.duration = duration;
            playListTraceMetrics.stopreason = stopreason;

            playListMetrics.trace.push(playListTraceMetrics);

            playListTraceMetricsClosed = true;
        }
    }

    function start() {
        if (!ready) return;
        addPlaylistTraceMetrics();
        isStopped = false;

        if (initialPlayback) {
            getInitRequest(currentRepresentationInfo.quality);
        } else {
            //Validate will be first called after the init segment is appended. But in the case where we stop and start
            //the ScheduleController E.g dateUpdate on manifest refresh for live streams. we need to start validate again.
            validate();
        }

        if (initialPlayback) {
            initialPlayback = false;
        }
        log('Schedule controller starting for ' + type);
    }



    function stop() {
        if (isStopped) return;
        isStopped = true;
        clearInterval(validateTimeout);
        log('Schedule controller stopping for ' + type);
    }

    function getInitRequest(quality) {
        var request = adapter.getInitRequest(streamProcessor, quality);

        if (request !== null) {
            fragmentModel.executeRequest(request);
        }

        return request;
    }

    function replaceCanceledRequests(canceledRequests) {
        var ln = canceledRequests.length;
        // EPSILON is used to avoid javascript floating point issue, e.g. if request.startTime = 19.2,
        // request.duration = 3.83, than request.startTime + request.startTime = 19.2 + 1.92 = 21.119999999999997
        var EPSILON = 0.1;
        var request,
            time,
            i;

        for (i = 0; i < ln; i++) {
            request = canceledRequests[i];
            time = request.startTime + (request.duration / 2) + EPSILON;
            request = adapter.getFragmentRequestForTime(streamProcessor, currentRepresentationInfo, time, {timeThreshold: 0, ignoreIsFinished: true});
            if (request) {
                fragmentModel.executeRequest(request);
            }
        }
    }

    function validate() {
        if (isStopped || playbackController.isPaused() && !scheduleWhilePaused) return;
        //log("validating", type);
        let readyToLoad = bufferLevelRule.execute(streamProcessor);
        if (readyToLoad && !isFragmentLoading &&
            (dashManifestModel.getIsTextTrack(type) || !bufferController.getIsAppendingInProgress())) {
            isFragmentLoading = true;

            const getNextFragment = function () {
                let request = nextFragmentRequestRule.execute(streamProcessor);
                if (request) {
                    fragmentModel.executeRequest(request); // we load
                } else {
                    isFragmentLoading = false;
                    startValidateTimer(1000); //we loop
                }
            };
            //Run ABR rules - let it callback to getNextFragment once it is done running.
            abrController.getPlaybackQuality(streamProcessor,  getNextFragment);

        } else {
            startValidateTimer(1000); //we loop
        }
    }

    function startValidateTimer(value) {
        validateTimeout = setTimeout(validate, value);
    }

    function onQualityChanged(e) {
        if (type !== e.mediaType || streamProcessor.getStreamInfo().id !== e.streamInfo.id) return;

        currentRepresentationInfo = streamProcessor.getRepresentationInfoForQuality(e.newQuality);
        if (currentRepresentationInfo === null || currentRepresentationInfo === undefined) {
            throw 'Unexpected error! - currentRepresentationInfo is null or undefined';
        }

        clearPlayListTraceMetrics(new Date(), PlayList.Trace.REPRESENTATION_SWITCH_STOP_REASON);
        addPlaylistTraceMetrics();
    }

    function onDataUpdateCompleted(e) {
        if (e.error) return;
        currentRepresentationInfo = adapter.convertDataToTrack(manifestModel.getValue(), e.currentRepresentation);
    }

    function onStreamInitialized(e) {
        if (e.error) return;

        currentRepresentationInfo = streamProcessor.getCurrentRepresentationInfo();

        if (!isDynamic || liveEdgeFinder.getLiveEdge() !== null) {
            ready = true;
        }

        start();
    }

    function onStreamCompleted(e) {
        if (e.fragmentModel !== fragmentModel) return;
        stop();
        log('Stream is complete');
    }

    function onFragmentLoadingCompleted(e) {
        if (e.sender !== fragmentModel) return;

        if (!isNaN(e.request.index)) {
            isFragmentLoading = false;
        }

        if (e.error && e.serviceLocation && !isStopped) {
            replaceCanceledRequests([e.request]);
        }
    }

    function onBytesAppended(e) {
        if (e.sender.getStreamProcessor() !== streamProcessor) return;
        validate();
    }

    function onDataUpdateStarted(e) {
        if (e.sender.getStreamProcessor() !== streamProcessor) return;
        stop();
    }

    function onInitRequested(e) {
        if (e.sender.getStreamProcessor() !== streamProcessor) return;

        getInitRequest(e.requiredQuality);
    }

    function onBufferCleared(e) {
        if (e.sender.getStreamProcessor() !== streamProcessor) return;
        // after the data has been removed from the buffer we should remove the requests from the list of
        // the executed requests for which playback time is inside the time interval that has been removed from the buffer
        fragmentModel.removeExecutedRequestsBeforeTime(e.to);

        if (e.hasEnoughSpaceToAppend && !bufferController.getIsBufferingCompleted()) {
            start();
        }
    }

    function onBufferLevelStateChanged(e) {
        if ((e.sender.getStreamProcessor() === streamProcessor) && e.state === BufferController.BUFFER_EMPTY && !playbackController.isSeeking()) {
            log('Stalling Buffer');
            clearPlayListTraceMetrics(new Date(), PlayList.Trace.REBUFFERING_REASON);
        }
    }

    function onQuotaExceeded(e) {
        if (e.sender.getStreamProcessor() !== streamProcessor) return;
        stop();
    }

    function onURLResolutionFailed() {
        fragmentModel.abortRequests();
        stop();
    }

    function addPlaylistTraceMetrics() {
        if (playListMetrics && playListTraceMetricsClosed === true && currentRepresentationInfo) {
            playListTraceMetricsClosed = false;

            playListTraceMetrics = new PlayList.Trace();
            playListTraceMetrics.representationid = currentRepresentationInfo.id;
            playListTraceMetrics.start = new Date();
            playListTraceMetrics.mstart = playbackController.getTime() * 1000;
            playListTraceMetrics.playbackspeed = playbackController.getPlaybackRate().toString();
        }
    }

    function onTimedTextRequested(e) {
        if (e.sender.getStreamProcessor() !== streamProcessor) return;
        getInitRequest(e.index);
    }

    function onPlaybackStarted() {
        start();
    }

    function onPlaybackSeeking(e) {

        seekTarget = e.seekTime;

        if (!initialPlayback) {
            isFragmentLoading = false;
        }
        if (isStopped) {
            start();
        }

        let metrics = metricsModel.getMetricsFor('stream');
        let manifestUpdateInfo = dashMetrics.getCurrentManifestUpdate(metrics);
        let latency = currentRepresentationInfo.DVRWindow ? currentRepresentationInfo.DVRWindow.end - playbackController.getTime() : NaN;
        metricsModel.updateManifestUpdateInfo(manifestUpdateInfo, {latency: latency});
    }

    function onPlaybackRateChanged(e) {
        if (playListTraceMetrics) {
            playListTraceMetrics.playbackspeed = e.playbackRate.toString();
        }
    }

    function onLiveEdgeSearchCompleted (e) {
        if (e.error) return;

        let liveEdgeTime = e.liveEdge;
        let manifestInfo = currentRepresentationInfo.mediaInfo.streamInfo.manifestInfo;
        let startTime = liveEdgeTime - playbackController.computeLiveDelay(currentRepresentationInfo.fragmentDuration, manifestInfo.DVRWindowSize / 2);
        let metrics = metricsModel.getMetricsFor('stream');
        let manifestUpdateInfo = dashMetrics.getCurrentManifestUpdate(metrics);
        let currentLiveStart = playbackController.getLiveStartTime();

        let request,
            actualStartTime;

        // get a request for a start time
        request = adapter.getFragmentRequestForTime(streamProcessor, currentRepresentationInfo, startTime, {ignoreIsFinished: true});
        actualStartTime = request.startTime;
        seekTarget = actualStartTime; //Setting seekTarget will allow NextFragmentRequestRule's first request time to be accurate.
        if (isNaN(currentLiveStart) || (actualStartTime > currentLiveStart)) {
            playbackController.setLiveStartTime(actualStartTime);
        }

        metricsModel.updateManifestUpdateInfo(manifestUpdateInfo, {currentTime: actualStartTime, presentationStartTime: liveEdgeTime, latency: liveEdgeTime - actualStartTime, clientTimeOffset: timelineConverter.getClientTimeOffset()});
        ready = true;
        start();
    }

    function getSeekTarget() {
        return seekTarget;
    }

    function setSeekTarget(value) {
        seekTarget = value;
    }

    function getFragmentModel() {
        return fragmentModel;
    }

    function setTimeToLoadDelay(value) {
        timeToLoadDelay = value;
    }

    function getTimeToLoadDelay() {
        return timeToLoadDelay;
    }

    function getStreamProcessor() {
        return streamProcessor;
    }

    function setPlayList(playList) {
        playListMetrics = playList;
    }

    function finalisePlayList(time, reason) {
        clearPlayListTraceMetrics(time, reason);
        playListMetrics = null;
    }

    function reset() {
        eventBus.off(Events.LIVE_EDGE_SEARCH_COMPLETED, onLiveEdgeSearchCompleted, this);
        eventBus.off(Events.DATA_UPDATE_STARTED, onDataUpdateStarted, this);
        eventBus.off(Events.DATA_UPDATE_COMPLETED, onDataUpdateCompleted, this);
        eventBus.off(Events.BUFFER_LEVEL_STATE_CHANGED, onBufferLevelStateChanged, this);
        eventBus.off(Events.QUALITY_CHANGED, onQualityChanged, this);
        eventBus.off(Events.FRAGMENT_LOADING_COMPLETED, onFragmentLoadingCompleted, this);
        eventBus.off(Events.STREAM_COMPLETED, onStreamCompleted, this);
        eventBus.off(Events.STREAM_INITIALIZED, onStreamInitialized, this);
        eventBus.off(Events.QUOTA_EXCEEDED, onQuotaExceeded, this);
        eventBus.off(Events.BYTES_APPENDED, onBytesAppended, this);
        eventBus.off(Events.BUFFER_CLEARED, onBufferCleared, this);
        eventBus.off(Events.INIT_REQUESTED, onInitRequested, this);
        eventBus.off(Events.PLAYBACK_RATE_CHANGED, onPlaybackRateChanged, this);
        eventBus.off(Events.PLAYBACK_SEEKING, onPlaybackSeeking, this);
        eventBus.off(Events.PLAYBACK_STARTED, onPlaybackStarted, this);
        eventBus.off(Events.URL_RESOLUTION_FAILED, onURLResolutionFailed, this);

        if (dashManifestModel.getIsTextTrack(type)) {
            eventBus.off(Events.TIMED_TEXT_REQUESTED, onTimedTextRequested, this);
        }

        stop();
        fragmentController.detachModel(fragmentModel);
        isFragmentLoading = false;
        timeToLoadDelay = 0;
        seekTarget = NaN;
        playbackController = null;
        playListMetrics = null;
    }

    instance = {
        initialize: initialize,
        getStreamProcessor: getStreamProcessor,
        getSeekTarget: getSeekTarget,
        setSeekTarget: setSeekTarget,
        getFragmentModel: getFragmentModel,
        setTimeToLoadDelay: setTimeToLoadDelay,
        getTimeToLoadDelay: getTimeToLoadDelay,
        replaceCanceledRequests: replaceCanceledRequests,
        start: start,
        stop: stop,
        reset: reset,
        setPlayList: setPlayList,
        finalisePlayList: finalisePlayList
    };

    setup();

    return instance;
}

ScheduleController.__dashjs_factory_name = 'ScheduleController';
export default FactoryMaker.getClassFactory(ScheduleController);
