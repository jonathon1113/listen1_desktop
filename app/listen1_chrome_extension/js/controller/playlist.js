/* eslint-disable no-unused-vars */
/* global angular MediaService sourceList */

angular.module('listenone').controller('PlayListController', [
  '$scope',
  '$timeout',
  ($scope) => {
    $scope.result = [];
    $scope.tab = sourceList[0].name;
    $scope.sourceList = sourceList;
    $scope.playlistFilters = {};
    $scope.allPlaylistFilters = {};
    $scope.currentFilterId = '';
    $scope.loading = true;
    $scope.showMore = false;

    $scope.$on('infinite_scroll:hit_bottom', (event, data) => {
      if ($scope.loading === true) {
        return;
      }
      $scope.loading = true;
      const offset = $scope.result.length;
      MediaService.showPlaylistArray(
        $scope.tab,
        offset,
        $scope.currentFilterId
      ).success((res) => {
        $scope.result = $scope.result.concat(res.result);
        $scope.loading = false;
        // 各平台的歌单请求走的是 Promise 回调，不在 angular 的 digest 周期内，
        // 这里只把数据写进了 scope，界面并不会刷新；必须显式补一次 digest，
        // 否则新追加的歌单要等到下一次偶然的 digest 才会显示出来。
        $scope.$evalAsync(() => {});
      });
    });

    $scope.loadPlaylist = () => {
      const offset = 0;
      $scope.showMore = false;
      MediaService.showPlaylistArray(
        $scope.tab,
        offset,
        $scope.currentFilterId
      ).success((res) => {
        $scope.result = res.result;
        $scope.loading = false;
        $scope.$evalAsync(() => {});
      });

      if (
        $scope.playlistFilters[$scope.tab] === undefined &&
        $scope.allPlaylistFilters[$scope.tab] === undefined
      ) {
        MediaService.getPlaylistFilters($scope.tab).success((res) => {
          $scope.playlistFilters[$scope.tab] = res.recommend;
          $scope.allPlaylistFilters[$scope.tab] = res.all;
          $scope.$evalAsync(() => {});
        });
      }
    };

    $scope.changeTab = (newTab) => {
      $scope.tab = newTab;
      $scope.result = [];
      $scope.currentFilterId = '';
      $scope.loadPlaylist();
    };

    $scope.changeFilter = (filterId) => {
      $scope.result = [];
      $scope.currentFilterId = filterId;
      $scope.loadPlaylist();
    };

    $scope.toggleMorePlaylists = () => {
      $scope.showMore = !$scope.showMore;
    };
  },
]);
